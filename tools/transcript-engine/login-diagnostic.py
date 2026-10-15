"""Bounded source experiment; optional one-off session, no retained login state."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import time
from urllib.parse import parse_qs, urlsplit

MAX_BYTES = 4 * 1024 * 1024


def message(value):
    if isinstance(value, dict):
        value = value.get('simpleText') or ''.join(r.get('text', '') for r in value.get('runs', []))
    return str(value or '')[:512]


def player_projection(player):
    status = player.get('playabilityStatus', {})
    error = status.get('errorScreen', {}).get('playerErrorMessageRenderer', {})
    tracks = player.get('captions', {}).get('playerCaptionsTracklistRenderer', {}).get('captionTracks', [])
    return {'status': status.get('status'), 'reason': message(status.get('reason')),
            'subreason': message(error.get('subreason')), 'error_reason': message(error.get('reason')),
            'video_id': player.get('videoDetails', {}).get('videoId'),
            'tracks': [{'language_code': t.get('languageCode'), 'vss_id': t.get('vssId'),
                        'kind': 'GENERATED' if t.get('kind') == 'asr' else 'MANUAL'} for t in tracks]}


def inspect_body(body, observations, source):
    text = body.decode('utf-8', 'replace')
    try:
        player = json.loads(text)
    except ValueError:
        match = re.search(r'(?:var\s+)?ytInitialPlayerResponse\s*=\s*', text)
        if not match:
            return
        try:
            player, _ = json.JSONDecoder().raw_decode(text[match.end():])
        except ValueError:
            return
    if isinstance(player, dict) and 'playabilityStatus' in player:
        observations.append({**player_projection(player), 'source': source})
        return player


def advertised_manual_track(player, video):
    if not player or player.get('videoDetails', {}).get('videoId') != video or player.get('playabilityStatus', {}).get('status') != 'OK':
        return None
    for track in player.get('captions', {}).get('playerCaptionsTracklistRenderer', {}).get('captionTracks', []):
        if track.get('languageCode') != 'en' or track.get('vssId') != '.en' or track.get('kind') is not None:
            continue
        url = track.get('baseUrl', '')
        locator = urlsplit(url)
        query = parse_qs(locator.query)
        if locator.scheme != 'https' or locator.hostname not in {'www.youtube.com', 'youtube.com'} or locator.path != '/api/timedtext' or locator.username or locator.password or locator.port not in {None, 443}:
            continue
        if query.get('v') != [video] or query.get('lang') != ['en'] or 'tlang' in query:
            continue
        return {'_url': url, 'language_code': 'en', 'kind': 'MANUAL', 'vss_id': '.en',
                'selection_source': 'WATCH_PLAYER_ADVERTISED_TRACK',
                'client': query.get('c', [None])[0], 'po_token_present': 'pot' in query,
                'experiment_flags': query.get('exp', [])}
    return None


def page_json(text, pattern):
    match = re.search(pattern, text)
    if not match:
        return None
    try:
        return json.JSONDecoder().raw_decode(text[match.end():].lstrip())[0]
    except ValueError:
        return None


def page_config(text):
    config = {}
    for match in re.finditer(r'ytcfg\.set\(\s*', text):
        try:
            value, _ = json.JSONDecoder().raw_decode(text[match.end():])
        except ValueError:
            continue
        if isinstance(value, dict):
            config.update(value)
    return config


def panel_endpoint(initial):
    for wrapper in (initial or {}).get('engagementPanels', []):
        panel = wrapper.get('engagementPanelSectionListRenderer', {})
        if panel.get('panelIdentifier') == 'engagement-panel-searchable-transcript':
            endpoint = panel.get('content', {}).get('continuationItemRenderer', {}).get('continuationEndpoint', {})
            return endpoint.get('innertubeCommand', endpoint.get('command', endpoint))
    return None


def write_cues(output, cues, result):
    assert cues and all(isinstance(c['text'], str) and c['text'].strip() and
                        isinstance(c['start_ms'], int) and isinstance(c['end_ms'], int) and
                        0 <= c['start_ms'] <= c['end_ms'] for c in cues)
    payload = (json.dumps(cues, ensure_ascii=False, indent=2) + '\n').encode()
    (output / 'segments.json').write_bytes(payload)
    (output / 'transcript.txt').write_text('\n'.join(c['text'] for c in cues) + '\n', encoding='utf-8')
    result.update(status='CAPTIONS_RECEIVED', cue_count=len(cues),
                  segments_sha256=hashlib.sha256(payload).hexdigest(),
                  first_start_ms=cues[0]['start_ms'], last_end_ms=cues[-1]['end_ms'])


def generate_subs_token(args, result):
    """Use the pinned stock provider; retain only transport metadata."""
    server = args.pot_server
    assert server and args.pot_trace
    assert str(server) == '/opt/bartosz-intelligence/browser-runtime/youtube-mweb/provider/server' or re.fullmatch(r'/home/bartosz-browser-runtime/snap/chromium/common/jobs/login-bgutils-prep-[0-9a-f]{8}/provider/server', str(server))
    entry = server / 'build/generate_once.js'
    assert hashlib.sha256(entry.read_bytes()).hexdigest() == 'd8a2ee807465547379f25ec9b24da973b026b2cf4518841167b1e4b401c19bdf'
    private = args.output / 'pot-private'
    private.mkdir(mode=0o700)
    trace = args.output / 'provider-transport.json'
    started = time.monotonic()
    metadata = result['subs_provider'] = {'name': 'bgutil-ytdlp-pot-provider', 'version': '2.0.2',
        'context': 'SUBS', 'binding': 'VIDEO_ID', 'content_binding': args.video,
        'cookies_supplied': False, 'token_received': False, 'private_state_removed': False}
    if getattr(args, 'pot_player', False):
        metadata['contexts'] = ['PLAYER', 'SUBS']
    try:
        env = {'PATH': '/opt/bartosz-intelligence/runtime/node-24.21.0/bin:/usr/bin:/bin',
            'HOME': str(private), 'TMPDIR': str(private), 'LANG': 'C.UTF-8',
            'XDG_CACHE_HOME': str(private), 'BARTOSZ_POT_SERVER': str(server),
            'BARTOSZ_POT_TRACE': str(trace), 'BARTOSZ_POT_MAX_REQUESTS': '8'}
        child = subprocess.run(['/opt/bartosz-intelligence/runtime/node-24.21.0/bin/node',
            '--max-old-space-size=256', '--import', str(args.pot_trace), str(entry),
            '--content-binding', args.video, '--bypass-cache'], cwd=server, env=env,
            capture_output=True, timeout=40)
        metadata['exit_code'] = child.returncode
        # Provider errors can include response bodies/tokens. Never persist stdout/stderr.
        metadata['stderr_bytes'] = len(child.stderr)
        if child.returncode != 0:
            # Diagnostic class only: provider stderr may contain token-bearing
            # URLs or response bodies and must never be persisted.
            metadata['failure_class'] = next((name for name, pattern in [
                ('MODULE_NOT_FOUND', rb'ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND'),
                ('ACCESS_DENIED', rb'EACCES|Permission denied'),
                ('FILE_NOT_FOUND', rb'ENOENT|No such file'),
                ('SYNTAX_ERROR', rb'SyntaxError'),
                ('NETWORK_ERROR', rb'ETIMEDOUT|ECONNRESET|ENETUNREACH|ENOTFOUND')]
                if re.search(pattern, child.stderr)), 'PROVIDER_PROCESS_FAILED')
            result['status'] = 'SUBS_PROVIDER_FAILED'
            return None
        if not 0 < len(child.stdout) <= 64 * 1024:
            raise ValueError('POT_OUTPUT_SIZE_INVALID')
        data = json.loads(child.stdout.splitlines()[-1])
        token = data.get('poToken')
        if data.get('contentBinding') != args.video or not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{64,4096}={0,2}', token):
            raise ValueError('POT_OUTPUT_INVALID')
        metadata.update(token_received=True, token_length=len(token))
        return token
    except subprocess.TimeoutExpired:
        metadata['timeout'] = True
        result['status'] = 'SUBS_PROVIDER_TIMEOUT'
        return None
    finally:
        metadata['elapsed_ms'] = round((time.monotonic() - started) * 1000)
        if trace.exists():
            telemetry = json.loads(trace.read_text())
            metadata['requests'] = telemetry['requests']
            metadata['total_response_bytes'] = telemetry['total_response_bytes']
        shutil.rmtree(private)
        metadata['private_state_removed'] = not private.exists()


def run(args, result):
    subs_token = None
    if getattr(args, 'pot_server', None):
        subs_token = generate_subs_token(args, result)
        if not subs_token:
            return
        if args.mode == 'pot':
            result['status'] = 'SUBS_TOKEN_RECEIVED_ONLY'
            return
    if args.mode == 'native':
        assert args.video == 'aircAruvnKk' and args.cookies and args.engine
        temporary = args.output / 'browser-tmp'
        temporary.mkdir(mode=0o700)
        config = args.output / 'native-config.json'
        config.write_text(json.dumps({'schema': 'ote-source:1', 'diagnostic_video_id': args.video,
                                     'browser_executable': '/opt/bartosz-intelligence/browser-runtime/snap-entry.py',
                                     'sandbox': True, 'session_cookie_path': str(args.cookies)}) + '\n')
        env = {**__import__('os').environ, 'TMPDIR': str(temporary)}
        child = subprocess.run(['/opt/bartosz-intelligence/runtime/node-24.21.0/bin/node',
                                '--max-old-space-size=192', str(args.engine), 'native', args.video,
                                str(config), str(args.output / 'capture')], env=env,
                               capture_output=True, timeout=75)
        result['native_exit_code'] = child.returncode
        capture = args.output / 'capture'
        if not (capture / 'result.json').exists():
            result['status'] = 'NATIVE_RESULT_MISSING'
            return
        native = json.loads((capture / 'result.json').read_text())
        diagnostic = json.loads((capture / 'native-diagnostics.json').read_text())
        result['native_result'] = native
        result['native_diagnostics'] = diagnostic
        result['cue_count'] = native.get('cue_count', 0)
        result['status'] = 'NATIVE_CAPTIONS_RECEIVED' if result['cue_count'] > 0 and diagnostic.get('transport_complete') else 'NATIVE_SOURCE_OR_CLIENT_FAILURE'
        # Only already sanitized engine artifacts are copied, never profile data.
        for name in ['transcript.txt', 'source-projection.json', 'snapshot.json']:
            if (capture / name).is_file():
                (args.output / name).write_bytes((capture / name).read_bytes())
        return
    import requests
    session = requests.Session()
    session.trust_env = False
    players = result['players']
    original_request = session.request

    def bounded_request(method, url, **kwargs):
        if len(result['requests']) >= args.max_requests:
            raise ValueError('REQUEST_LIMIT')
        kwargs.update(timeout=(5, 15), stream=True, allow_redirects=False)
        response = original_request(method, url, **kwargs)
        body = bytearray()
        try:
            for chunk in response.iter_content(65536):
                body.extend(chunk)
                if len(body) > MAX_BYTES:
                    raise ValueError('RESPONSE_LIMIT')
        finally:
            response.close()
        response._content = bytes(body)
        response._content_consumed = True
        locator = urlsplit(url)
        result['requests'].append({'method': method, 'host': locator.hostname,
                                  'path': locator.path, 'http_status': response.status_code,
                                  'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()})
        inspect_body(body, players, {'host': locator.hostname, 'path': locator.path})
        return response

    session.request = bounded_request
    try:
        if args.mode in {'watch', 'panel'}:
            response = session.get('https://www.youtube.com/watch?v=' + args.video,
                                   headers={'Accept-Language': 'en-US,en;q=0.9'})
            result['status'] = 'PLAYER_OBSERVED' if players else 'NO_PLAYER_RESPONSE'
            result['http_status'] = response.status_code
            if args.mode == 'panel':
                initial = page_json(response.text, r'(?:var\s+)?ytInitialData\s*=\s*')
                config = page_config(response.text)
                endpoint = panel_endpoint(initial)
                result['panel_metadata'] = {'initial_data_present': initial is not None,
                                            'context_present': isinstance(config, dict) and 'INNERTUBE_CONTEXT' in config,
                                            'endpoint_present': bool(endpoint)}
                if not endpoint:
                    result['status'] = 'NO_ADVERTISED_TRANSCRIPT_ENDPOINT'
                    return
                api_path = endpoint.get('commandMetadata', {}).get('webCommandMetadata', {}).get('apiUrl')
                payload = endpoint.get('getTranscriptEndpoint')
                if api_path != '/youtubei/v1/get_transcript' or not isinstance(payload, dict) or not config.get('INNERTUBE_CONTEXT'):
                    result['status'] = 'TRANSCRIPT_ENDPOINT_SCHEMA_CHANGED'
                    return
                result['panel_metadata']['endpoint_payload_sha256'] = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
                client = config['INNERTUBE_CONTEXT'].get('client', {})
                headers = {'Origin': 'https://www.youtube.com',
                           'Referer': 'https://www.youtube.com/watch?v=' + args.video,
                           'X-Youtube-Client-Name': str(config.get('INNERTUBE_CONTEXT_CLIENT_NAME', 1)),
                           'X-Youtube-Client-Version': str(client.get('clientVersion', ''))}
                if client.get('visitorData'):
                    headers['X-Goog-Visitor-Id'] = client['visitorData']
                response = session.post('https://www.youtube.com' + api_path,
                                        json={'context': config['INNERTUBE_CONTEXT'], **payload},
                                        headers=headers)
                body = response.content
                data = response.json()
                result['panel_http_status'] = response.status_code
                result['panel_error'] = {'code': data.get('error', {}).get('code'),
                                         'message': message(data.get('error', {}).get('message'))}
                if response.status_code != 200 or data.get('error'):
                    result['status'] = 'TRANSCRIPT_ENDPOINT_REFUSED'
                    return
                (args.output / 'panel.raw').write_bytes(body)
                result['status'] = 'TRANSCRIPT_RESPONSE_RECEIVED_UNPARSED'
        elif args.mode == 'library':
            from youtube_transcript_api import YouTubeTranscriptApi
            result['package_version'] = importlib.metadata.version('youtube-transcript-api')
            listing = list(YouTubeTranscriptApi(http_client=session).list(args.video))
            result['tracks'] = [{'language_code': t.language_code, 'kind': 'GENERATED' if t.is_generated else 'MANUAL'} for t in listing]
            english = [t for t in listing if t.language_code == 'en']
            if not english:
                result['status'] = 'NO_ENGLISH_TRACK'
                return
            selected = sorted(english, key=lambda t: t.is_generated)[0]
            result['selected'] = {'language_code': selected.language_code, 'kind': 'GENERATED' if selected.is_generated else 'MANUAL'}
            fetched = selected.fetch()
            cues = [{'start_ms': round(c.start * 1000), 'end_ms': round((c.start + c.duration) * 1000), 'text': c.text} for c in fetched.snippets]
            write_cues(args.output, cues, result)
        else:
            import yt_dlp
            result['package_version'] = importlib.metadata.version('yt-dlp')
            logs = result['extractor_messages'] = []

            class Logger:
                def debug(self, value):
                    pass

                def warning(self, value):
                    if subs_token:
                        value = str(value).replace(subs_token, '[TOKEN]')
                    logs.append(message(re.sub(r'https?://\S+', '[URL]', value)))

                error = warning

            options = {'ignoreconfig': True, 'quiet': True, 'no_warnings': False,
                       'noplaylist': True, 'skip_download': True, 'ignore_no_formats_error': True,
                       'writesubtitles': True,
                       'socket_timeout': 10, 'retries': 0, 'extractor_retries': 0,
                       'cachedir': False, 'proxy': '', 'logger': Logger(), 'remote_components': [],
                       'js_runtimes': {'deno': {'path': '/opt/bartosz-intelligence/runtime/deno-2.9.7/deno'}},
                       'extractor_args': {'youtube': {'player_client': [args.client], 'skip': ['translated_subs']}}}
            if args.cookies:
                assert (args.video == 'aircAruvnKk' or args.persistent_session) and args.client in {'web', 'mweb'}
                options['cookiefile'] = str(args.cookies)
            if subs_token:
                assert args.client == 'mweb'
                options['extractor_args']['youtube']['po_token'] = ['mweb.subs+' + subs_token]
                options['extractor_args']['youtube']['fetch_pot'] = ['never']
                if args.pot_player:
                    assert not args.cookies
                    options['extractor_args']['youtube']['po_token'].append('mweb.player+' + subs_token)
            with yt_dlp.YoutubeDL(options) as ydl:
                urlopen = ydl.urlopen
                watch_track = None

                def capture(request):
                    nonlocal watch_track
                    if len(result['requests']) >= args.max_requests:
                        raise ValueError('REQUEST_LIMIT')
                    request_url = request if isinstance(request, str) else getattr(request, 'url', '')
                    requested = urlsplit(request_url)
                    observation = {'host': requested.hostname, 'path': requested.path,
                                   'http_status': None, 'bytes': 0, 'sha256': None}
                    result['requests'].append(observation)
                    from yt_dlp.networking.exceptions import HTTPError
                    http_error = None
                    try:
                        response = urlopen(request)
                    except HTTPError as error:
                        response = error.response
                        http_error = error
                    except Exception as error:
                        observation['error_type'] = type(error).__name__
                        cause = getattr(error, 'cause', None)
                        observation['cause_type'] = type(cause).__name__ if cause else None
                        observation['transport_handler'] = getattr(getattr(error, 'handler', None), 'RH_KEY', None)
                        raise
                    # yt-dlp's response may be seekless. Read once, replay via BytesIO.
                    import io
                    try:
                        body = response.read(MAX_BYTES + 1)
                    except Exception:
                        response.close()
                        raise
                    if len(body) > MAX_BYTES:
                        response.close()
                        raise ValueError('RESPONSE_LIMIT')
                    if sum(row['bytes'] for row in result['requests']) + result.get('subs_provider', {}).get('total_response_bytes', 0) + len(body) > 32 * 1024 * 1024:
                        response.close()
                        raise ValueError('TOTAL_RESPONSE_LIMIT')
                    response.read = io.BytesIO(body).read
                    locator = urlsplit(response.url)
                    observation.update(host=locator.hostname, path=locator.path,
                                       http_status=response.status, bytes=len(body),
                                       sha256=hashlib.sha256(body).hexdigest())
                    source = {'host': locator.hostname, 'path': locator.path}
                    request_data = getattr(request, 'data', None)
                    if request_data:
                        try:
                            payload = json.loads(request_data)
                            client = payload.get('context', {}).get('client', {})
                            source.update(client_name=client.get('clientName'), client_version=client.get('clientVersion'))
                            if args.pot_player and locator.path == '/youtubei/v1/player':
                                source['player_po_token_present'] = bool(subs_token and payload.get('serviceIntegrityDimensions', {}).get('poToken') == subs_token)
                        except (ValueError, TypeError):
                            pass
                    player = inspect_body(body, players, source)
                    if args.cookies and locator.hostname == 'www.youtube.com' and locator.path == '/watch':
                        logged_in = page_config(body.decode('utf-8', 'replace')).get('LOGGED_IN')
                        result['watch_logged_in'] = logged_in if isinstance(logged_in, bool) else None
                        watch_track = advertised_manual_track(player, args.video)
                    if http_error:
                        response.close()
                        raise http_error
                    return response

                ydl.urlopen = capture
                info = ydl.extract_info('https://www.youtube.com/watch?v=' + args.video, download=False)
                result['tracks'] = [{'language_code': language, 'kind': kind}
                                    for key, kind in [('subtitles', 'MANUAL'), ('automatic_captions', 'GENERATED')]
                                    for language in (info.get(key) or {})]
                selected = None
                if getattr(args, 'adapter', False):
                    spec = importlib.util.spec_from_file_location('authoritative_caption_parser', args.parser)
                    adapter_parser = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(adapter_parser)
                    provider_tracks = adapter_parser.tracks_from_info(info)
                    public = lambda track: {key: value for key, value in track.items() if not key.startswith('_')}
                    result['provider_tracks'] = [public(track) for track in provider_tracks]
                    provider_language = info.get('language') if isinstance(info.get('language'), str) else None
                    result['video_language'] = provider_language or getattr(args, 'default_audio_language', None)
                    result['video_language_provenance'] = 'yt_dlp.info.language' if provider_language else \
                        'youtube.videos.snippet.defaultAudioLanguage' if result['video_language'] else None
                    primary = lambda value: value.lower().split('-')[0]
                    usable = [track for track in provider_tracks if track['is_translated'] is False and track['is_generated'] is not None and track['track_kind'] in {'MANUAL','GENERATED'}]
                    explicit = {primary(track['language_code']) for track in usable if track['is_original'] is True}
                    original = next(iter(explicit)) if len(explicit) == 1 else primary(result['video_language']) if not explicit and result['video_language'] else None
                    if original is None and not explicit and not result['video_language'] and usable and all(primary(track['language_code']) == 'pl' for track in usable):
                        original = 'pl'
                    candidates = [track for track in usable if original and primary(track['language_code']) == original and track['is_original'] is not False]
                    if candidates:
                        def core_track_id(track):
                            identity = [args.item_id, track['language_code'], track['track_kind'], track['extension'], track['source_language']]
                            return hashlib.sha256(json.dumps(identity, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
                        chosen = min(candidates, key=lambda track: (track['track_kind'] != 'MANUAL', core_track_id(track)))
                        selected = {'url': chosen['_url'], 'ext': chosen['extension']}
                        result['provider_selected'] = public(chosen)
                        result['selected'] = {'language_code': chosen['language_code'], 'kind': chosen['track_kind'],
                            'client': parse_qs(urlsplit(chosen['_url']).query).get('c', [None])[0],
                            'po_token_present': 'pot' in parse_qs(urlsplit(chosen['_url']).query)}
                kinds = [('subtitles', 'MANUAL')] if args.cookies else [('subtitles', 'MANUAL'), ('automatic_captions', 'GENERATED')]
                for key, kind in ([] if getattr(args, 'adapter', False) else kinds):
                    for language, rows in (info.get(key) or {}).items():
                        if language not in {'en', 'en-orig'}:
                            continue
                        for row in rows:
                            locator = urlsplit(row.get('url', ''))
                            query = parse_qs(locator.query)
                            if row.get('ext') == 'json3' and locator.hostname in {'www.youtube.com', 'youtube.com'} and locator.path == '/api/timedtext' and 'tlang' not in query:
                                selected = row
                                result['selected'] = {'language_code': language, 'kind': kind,
                                                      'client': query.get('c', [None])[0],
                                                      'po_token_present': 'pot' in query,
                                                      'experiment_flags': query.get('exp', [])}
                                break
                        if selected:
                            break
                    if selected:
                        break
                if not selected and args.cookies and args.client == 'web' and watch_track:
                    # Complete the same caption test with the exact URL YouTube
                    # advertised. Keep signatures/client parameters unchanged.
                    selected = {'url': watch_track['_url']}
                    result['selected'] = {key: value for key, value in watch_track.items() if key != '_url'}
                if not selected:
                    result['status'] = 'PLAYER_REFUSED' if any(p['status'] == 'LOGIN_REQUIRED' for p in players) else 'UNKNOWN_SOURCE_AUTHORITY' if getattr(args, 'adapter', False) and result['tracks'] else 'SUBTITLE_PO_TOKEN_REQUIRED' if any('PO Token' in line and 'subtitle' in line.lower() for line in logs) else 'NO_ORIGINAL_ENGLISH_JSON3_TRACK'
                    return
                caption_request = selected['url']
                if getattr(args, 'persistent_session', False):
                    from yt_dlp.networking import Request
                    headers = selected.get('http_headers') or {}
                    caption_request = Request(caption_request, headers=headers, extensions={'timeout': 20})
                    result['caption_socket_timeout_seconds'] = 20
                    result['caption_advertised_header_count'] = len(headers)
                response = ydl.urlopen(caption_request)
                body = response.read(MAX_BYTES + 1)
                response.close()
                (args.output / 'caption.raw').write_bytes(body)
                result['caption_bytes'] = len(body)
                result['status'] = 'CAPTION_RESPONSE_RECEIVED_UNPARSED' if body else 'EMPTY_CAPTION_RESPONSE'
                if body and args.parser:
                    spec = importlib.util.spec_from_file_location('authoritative_caption_parser', args.parser)
                    parser = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(parser)
                    prefix = body.decode('utf-8-sig', 'replace').lstrip()
                    extension = 'json3' if prefix.startswith('{') else 'vtt' if prefix.startswith('WEBVTT') else 'xml'
                    result['caption_format'] = extension
                    cues = parser.decode_segments(body, extension)
                    if not cues:
                        result['status'] = 'CAPTION_PARSER_REJECTED'
                    else:
                        write_cues(args.output, cues, result)
    finally:
        session.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['watch', 'panel', 'library', 'ytdlp', 'native', 'pot'])
    parser.add_argument('output', type=Path)
    parser.add_argument('--video', default='aircAruvnKk')
    parser.add_argument('--client', choices=['default', 'mweb', 'web', 'web_embedded', 'android_vr'], default='mweb')
    parser.add_argument('--cookies', type=Path)
    parser.add_argument('--parser', type=Path)
    parser.add_argument('--engine', type=Path)
    parser.add_argument('--pot-server', type=Path)
    parser.add_argument('--pot-trace', type=Path)
    parser.add_argument('--pot-player', action='store_true')
    parser.add_argument('--persistent-session', action='store_true')
    parser.add_argument('--adapter', action='store_true')
    parser.add_argument('--item-id')
    parser.add_argument('--default-audio-language')
    parser.add_argument('--max-requests', type=int, choices=range(1, 9), default=8)
    args = parser.parse_args()
    assert re.fullmatch(r'[\w-]{11}', args.video)
    assert not args.adapter or (args.item_id and re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', args.item_id))
    assert args.default_audio_language is None or (args.adapter and len(args.default_audio_language) <= 64 \
        and re.fullmatch(r'[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*', args.default_audio_language))
    if args.mode == 'pot' or args.pot_server:
        assert args.mode in {'pot', 'ytdlp'} and args.pot_server and args.pot_trace
        assert (args.video == 'aircAruvnKk' or args.persistent_session) and not (args.mode == 'pot' and args.cookies)
        assert args.mode != 'ytdlp' or args.client == 'mweb'
    assert not args.pot_player or (args.mode == 'ytdlp' and args.pot_server and not args.cookies)
    args.output.mkdir(parents=True, exist_ok=True)
    assert not (args.output / 'result.json').exists()
    started = time.monotonic()
    result = {'schema': 'ote-login-diagnostic:1', 'mode': args.mode, 'video_id': args.video,
              'client': args.client if args.mode == 'ytdlp' else None,
              'observed_utc': datetime.now(timezone.utc).isoformat(), 'architecture': platform.machine(),
              'python_version': '.'.join(map(str,sys.version_info[:3])),
              'anonymous': not bool(args.cookies), 'requests': [], 'players': []}
    try:
        run(args, result)
    except Exception as error:
        result.update(status='SOURCE_OR_CLIENT_FAILURE', error_type=type(error).__name__,
                      error_message='PROVIDER_OR_CLIENT_FAILURE' if args.pot_server else message(re.sub(r'https?://\S+', '[URL]', str(error))))
    result['elapsed_ms'] = round((time.monotonic() - started) * 1000)
    (args.output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': result['status'], 'players': result['players'], 'cue_count': result.get('cue_count', 0)}))


if __name__ == '__main__':
    main()
