#!/usr/bin/env python3
"""Plain-style render of a recorded clip (recweb.cjs / recext.cjs / recpage.cjs format) for the portfolio videos.

post.py <clipdir> <out.mp4> [--crop x0,y0,x1,y1] [--voice] [--phone] [--touch] [--pad SECONDS] [--no-cursor]

Portfolio version of the help-center post.py (plain style only). Every clip is 1920x1080:
the crop is fitted into a 1920x968 area on a dark background, with a 112 px caption bar under it, so
clips of any crop join with `-c copy`. --phone draws the crop as a phone (rounded screen and bezel),
--touch draws a finger dot instead of the arrow cursor. Captions come from events.json `text`; the
narration (`say`, see tts.py) plays from voice.json. Quiet stretches play at 1.5x, and the frame holds
while a line finishes. Writes <out>.timing.json with each narration line's start and length in the output.
"""
import json, os, subprocess, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

clip = Path(sys.argv[1]); out = sys.argv[2]
args = sys.argv[3:]
crop = None
pad_end = 0.0
phone = '--phone' in args
touch = '--touch' in args
show_cursor = '--no-cursor' not in args
SPEED = 1.5  # quiet stretches (no narration) play a little faster
voice = json.loads((clip / 'voice.json').read_text()) if '--voice' in args else None
for i, a in enumerate(args):
    if a == '--crop': crop = tuple(int(v) for v in args[i + 1].split(','))
    if a == '--pad': pad_end = float(args[i + 1])
FPS = 30
CW, CH = 1920, 1080
CAPBAR = 112
AREA_H = CH - CAPBAR
BG = (30, 34, 44)

times = json.loads((clip / 'frames.json').read_text())
events = json.loads((clip / 'events.json').read_text())
first = Image.open(clip / 'f00000.jpg')
if crop is None:
    crop = (0, 0, first.width, first.height)
X0, Y0, X1, Y1 = crop
SW, SH = X1 - X0, Y1 - Y0
BEZEL = 16 if phone else 0
K = min(CW / SW, (AREA_H - (2 * BEZEL + 28 if phone else 0)) / SH)  # source px -> output px
BOX_W, BOX_H = round(SW * K), round(SH * K)
BOX_X, BOX_Y = (CW - BOX_W) // 2, (AREA_H - BOX_H) // 2

duration = events[-1]['t'] + pad_end
# timeline: hold the end of each caption segment until its narration finishes
SEGS = []  # (out_start, src_start, src_len, out_len, need)
# start at the first recorded frame: recweb.cjs begins capturing after the first page load
T0 = max(0.0, min([times[0]] + [e['t'] for e in events if e['type'] == 'caption']))
if voice:
    bounds = [T0] + [v['t'] for v in voice] + [duration]
    o = 0.0
    for i in range(len(bounds) - 1):
        a, b = bounds[i], bounds[i + 1]
        need = (voice[i - 1]['dur'] + 0.45) if i >= 1 else 0.0
        ln = b - a
        out_len = need + (ln - need) / SPEED if ln > need else need
        SEGS.append((o, a, ln, out_len, need)); o += out_len
    out_duration = o
else:
    SEGS = [(0.0, T0, duration - T0, duration - T0, duration - T0)]; out_duration = duration - T0

def src_time(ot):
    for o0, a, ln, ol, need in SEGS:
        if ot < o0 + ol:
            loc = ot - o0
            if loc <= need:
                return a + min(loc, max(0.0, ln - 1e-3))
            return a + min(need + (loc - need) * SPEED, max(0.0, ln - 1e-3))
    o0, a, ln, ol, need = SEGS[-1]
    return a + ln

def ease(k):
    k = max(0.0, min(1.0, k))
    return 4 * k * k * k if k < 0.5 else 1 - (-2 * k + 2) ** 3 / 2

# ---------- static background (phone bezel) and screen mask ----------
bg = Image.new('RGB', (CW, CH), BG)
mask = Image.new('L', (BOX_W, BOX_H), 255)
if phone:
    r = 44
    d = ImageDraw.Draw(bg)
    d.rounded_rectangle([BOX_X - BEZEL, BOX_Y - BEZEL, BOX_X + BOX_W + BEZEL, BOX_Y + BOX_H + BEZEL], r + BEZEL, fill=(12, 13, 17), outline=(78, 84, 98), width=3)
    mask = Image.new('L', (BOX_W, BOX_H), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, BOX_W - 1, BOX_H - 1], r, fill=255)

def font(size):
    for p in ['/System/Library/Fonts/SFNS.ttf', '/System/Library/Fonts/Helvetica.ttc', '/Library/Fonts/Arial.ttf']:
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            pass
    return ImageFont.load_default()
CAP_FONT = font(40)

# ---------- cursor ----------
moves = [e for e in events if e['type'] in ('cursor', 'move')]
clicks = [e for e in events if e['type'] == 'click']
hide = [e for e in events if e['type'] in ('hidecursor', 'showcursor')]

def cursor_visible(t):
    vis = show_cursor
    for e in hide:
        if t >= e['t']:
            vis = e['type'] == 'showcursor'
    return vis

def cursor(t):
    x, y = moves[0]['x'], moves[0]['y']
    for m in moves[1:]:
        if t < m['t']:
            break
        k = (t - m['t']) / m['dur']
        if k >= 1:
            x, y = m['x'], m['y']
        else:
            e = 2 * k * k if k < 0.5 else 1 - (-2 * k + 2) ** 2 / 2
            x, y = m['x0'] + (m['x'] - m['x0']) * e, m['y0'] + (m['y'] - m['y0']) * e
    return (x - X0) * K, (y - Y0) * K

ARROW = [(0, 0), (0, 23), (6, 17.5), (10.5, 27), (14.5, 25), (10, 16), (17.5, 16)]

def draw_cursor(img, x, y, size, pressed):
    dd = ImageDraw.Draw(img, 'RGBA')
    if touch:
        r = 26 if not pressed else 22
        dd.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, 120), outline=(20, 20, 20, 170), width=3)
        return
    k = size / 27
    pts = [(x + px * k, y + py * k) for px, py in ARROW]
    sh = [(px + 1.5 * k, py + 2.5 * k) for px, py in pts]
    dd.polygon(sh, fill=(0, 0, 0, 70))
    dd.polygon(pts, fill=(255, 255, 255, 255), outline=(10, 10, 10, 255))
    dd.line(pts + [pts[0]], fill=(10, 10, 10, 255), width=max(1, round(1.6 * k)))

# ---------- captions ----------
caps = [(e['t'], e['text']) for e in events if e['type'] == 'caption']
_cap_cache = {}

def cap_image(text):
    if text in _cap_cache:
        return _cap_cache[text]
    fnt = CAP_FONT; lh = 52
    img = Image.new('RGBA', (CW, lh + 10), (0, 0, 0, 0))
    dd = ImageDraw.Draw(img)
    w = fnt.getlength(text)
    dd.text(((CW - w) / 2 + 2, 3), text, font=fnt, fill=(0, 0, 0, 110))
    dd.text(((CW - w) / 2, 0), text, font=fnt, fill=(255, 255, 255, 255))
    _cap_cache[text] = img
    return img

def caption_at(t):
    cur, start, prev = None, 0.0, None
    for ts, tx in caps:
        if t >= ts:
            prev, cur, start = cur, tx, ts
    return cur, start, prev

# ---------- render ----------
_src = {'i': -1, 'img': None}

def source(t):
    i = 0
    lo, hi = 0, len(times) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if times[mid] <= t:
            i = mid; lo = mid + 1
        else:
            hi = mid - 1
    if _src['i'] != i:
        im = Image.open(clip / f'f{i:05d}.jpg').convert('RGB').crop(crop)
        _src['img'] = im.resize((BOX_W, BOX_H), Image.LANCZOS)
        _src['i'] = i
    return _src['img']

ff = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{CW}x{CH}', '-r', str(FPS), '-i', '-',
                       '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', str(FPS), '-movflags', '+faststart', out], stdin=subprocess.PIPE)
n = int(round(out_duration * FPS))
for fi in range(n):
    t = src_time(fi / FPS)
    view = source(t).copy()
    if cursor_visible(t):
        vx, vy = cursor(t)
        pressed = False
        for c in clicks:
            dt = t - c['t']
            if 0 <= dt < 0.5:
                pressed = dt < 0.15
                r = 10 + 46 * ease(dt / 0.5)
                a = int(150 * (1 - dt / 0.5))
                ImageDraw.Draw(view, 'RGBA').ellipse([vx - r, vy - r, vx + r, vy + r], outline=(255, 170, 40, a), width=5)
        draw_cursor(view, vx, vy, 32, pressed)
    frame = bg.copy()
    frame.paste(view, (BOX_X, BOX_Y), mask)
    text, start, prev = caption_at(t)
    if text:
        ci = cap_image(text)
        cy0 = AREA_H + (CAPBAR - ci.height) // 2 + 4
        k = min(1.0, (t - start) / 0.18)
        if k < 0.5 and prev:
            pi = cap_image(prev).copy(); pi.putalpha(pi.getchannel('A').point(lambda v: int(v * (1 - 2 * k))))
            frame.paste(pi, (0, cy0), pi)
        ci2 = ci.copy(); ci2.putalpha(ci.getchannel('A').point(lambda v: int(v * k)))
        frame.paste(ci2, (0, cy0 + int(8 * (1 - k))), ci2)
    ff.stdin.write(frame.tobytes())
ff.stdin.close(); ff.wait()
timing = []
tmp = out + '.v.mp4'
os.replace(out, tmp)
cmd = ['ffmpeg', '-v', 'error', '-y', '-i', tmp]
if voice:
    for v in voice: cmd += ['-i', v['file']]
    parts = []
    for i, v in enumerate(voice):
        st = SEGS[i + 1][0] + 0.15
        timing.append({'start': round(st, 3), 'dur': v['dur'], 'text': v['text']})
        ms = int(st * 1000)
        parts.append(f'[{i + 1}:a]adelay={ms}|{ms},aresample=44100,aformat=channel_layouts=stereo[a{i}]')
    mix = ''.join(f'[a{i}]' for i in range(len(voice)))
    fc = ';'.join(parts) + f';{mix}amix=inputs={len(voice)}:normalize=0,apad[aout]'
    cmd += ['-filter_complex', fc, '-map', '0:v', '-map', '[aout]']
else:  # silent track so every clip joins with -c copy
    cmd += ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-map', '0:v', '-map', '1:a']
cmd += ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-shortest', '-movflags', '+faststart', out]
subprocess.run(cmd, check=True); os.remove(tmp)
Path(out + '.timing.json').write_text(json.dumps({'seconds': round(n / FPS, 3), 'voice': timing}, indent=1))
print(json.dumps({'out': out, 'seconds': round(out_duration, 1), 'frames': n}))
