#!/usr/bin/env python3
"""Generate narration for each caption of the recorded scenes with Von's ElevenLabs voice.

Portfolio copy of the help-center tts.py: speaks each caption event's `say` (the caption bar shows the
shorter `text`) and adds no intro (the portfolio scripts open with their own "Hi, I'm Von").

tts.py <builddir> <scene> [<scene> ...] [--no-intro]
Writes <builddir>/voice/<sha>.mp3 (cached by text) and <builddir>/<scene>/voice.json:
[{"t": caption_time, "text": spoken_text, "file": path, "dur": seconds}, ...]
Only the narration text is sent to ElevenLabs. The key comes from ELEVENLABS_API_KEY in the environment
(run this under your secret manager); it is never written to disk or printed.
"""
import hashlib, json, os, re, subprocess, sys, urllib.request, urllib.error
from pathlib import Path

VOICE = 'B6qG4FAE270gUbWkFo7a'   # "Von's Voice"
SETTINGS = {"model_id": "eleven_v4", "voice_settings": {"stability": 0.5, "similarity_boost": 0.75, "speed": 1.0}}
# Von, 2026-10-11: every narration plays at 1.20x. The API's speed setting had no measurable
# effect on eleven_v4, so each clip is sped up after download with ffmpeg atempo (pitch kept).
TEMPO = 1.20
NUM = {'1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine', '10': 'ten'}
INTRO = ""  # portfolio scripts carry their own intro line

def speech(text):
    s = text
    s = re.sub(r'Part (\d+):', lambda m: 'Part ' + NUM.get(m.group(1), m.group(1)) + '.', s)
    s = s.replace(' = ', ' equals ').replace(' AND ', ' and ').replace(' > ', ', then ')
    return s

def duration(p):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(p)], capture_output=True, text=True).stdout
    return float(out.strip())

def tts(text, path, key):
    if not key:
        sys.exit('ELEVENLABS_API_KEY is not set and this line is not cached yet: ' + text[:60])
    body = json.dumps(dict(SETTINGS, text=text)).encode()
    r = urllib.request.Request(f'https://api.elevenlabs.io/v1/text-to-speech/{VOICE}?output_format=mp3_44100_128', data=body, method='POST',
                               headers={'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg'})
    raw = path.with_suffix('.raw.mp3')
    raw.write_bytes(urllib.request.urlopen(r, timeout=120).read())
    if TEMPO == 1.0:
        raw.rename(path)
        return
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(raw), '-filter:a', f'atempo={TEMPO}', '-b:a', '128k', str(path)], check=True)
    raw.unlink()

# --no-intro: re-narrating single scenes of a video whose first scene is not among them.
no_intro = '--no-intro' in sys.argv
build = Path(sys.argv[1]); scenes = [a for a in sys.argv[2:] if a != '--no-intro']
key = os.environ.get('ELEVENLABS_API_KEY', '').strip()  # only needed for clips not in the cache
(build / 'voice').mkdir(exist_ok=True)
chars = 0
for si, sc in enumerate(scenes):
    events = json.loads((build / sc / 'events.json').read_text())
    caps = [e for e in events if e['type'] == 'caption']
    out = []
    for ci, e in enumerate(caps):
        text = speech(e.get('say') or e['text'])
        if INTRO and si == 0 and ci == 0 and not no_intro and not text.startswith("Hi, I'm Von"):  # a storyboard may open with its own intro
            text = INTRO + text
        h = hashlib.sha1(json.dumps([text, SETTINGS, VOICE, TEMPO]).encode()).hexdigest()[:16]
        p = build / 'voice' / f'{h}.mp3'
        if not p.exists():
            tts(text, p, key); chars += len(text)
        out.append({'t': e['t'], 'text': text, 'file': str(p.resolve()), 'dur': duration(p)})
    (build / sc / 'voice.json').write_text(json.dumps(out, indent=1))
    print(sc, len(out), 'clips', round(sum(x['dur'] for x in out), 1), 's')
print('characters sent:', chars)
