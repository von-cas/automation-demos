#!/usr/bin/env python3
"""Title, chapter and closing cards in the site's datasheet look, as clips that join with post.py output.

card.py <out.mp4> --title TEXT [--kicker TEXT] [--sub TEXT] [--secs 1.0] [--voice clip.mp3] [--delay 0.3]
        [--dark] [--png out.png] [--font-dir DIR]

  --title    the big serif line ("\\n" breaks the line; text after "|" is set in the accent italic,
             e.g. "Score the |lead")
  --kicker   small mono line above the title, e.g. "Part 2 of 4"
  --sub      mono line under the rule, e.g. the "Try it live" URL on the closing card
  --secs     length (default 1.0 s, the chapter-card length); with --voice it grows to fit the line + 0.6 s
  --voice    an mp3 from tts.py to play over the card, starting after --delay seconds
  --font-dir folder with InstrumentSerif-Regular.ttf, InstrumentSerif-Italic.ttf and JetBrainsMono-Regular.ttf
             (the site fonts, OFL). Without it the card uses Georgia and Menlo, the site's own fallbacks.

Encoding matches post.py (1920x1080, 30 fps, H.264 CRF 18, yuv420p, AAC 160k 44.1 kHz stereo), so cards and
clips join with `ffmpeg -f concat -c copy`.
"""
import argparse, subprocess, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
LIGHT = dict(paper=(247, 247, 244), ink=(26, 24, 22), ink3=(104, 100, 89), rule=(201, 197, 188), accent=(176, 61, 28))
DARK = dict(paper=(20, 19, 17), ink=(236, 235, 230), ink3=(169, 165, 155), rule=(59, 57, 52), accent=(236, 138, 95))
ENC = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30',
       '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2']


def font(paths, size):
    for p in paths:
        try:
            return ImageFont.truetype(str(p), size)
        except OSError:
            continue
    return ImageFont.load_default(size)


def fonts(font_dir):
    d = Path(font_dir) if font_dir else None
    sup = Path('/System/Library/Fonts/Supplemental')
    serif = ([d / 'InstrumentSerif-Regular.ttf'] if d else []) + [sup / 'Georgia.ttf', sup / 'Times New Roman.ttf']
    italic = ([d / 'InstrumentSerif-Italic.ttf'] if d else []) + [sup / 'Georgia Italic.ttf', sup / 'Times New Roman Italic.ttf']
    mono = ([d / 'JetBrainsMono-Regular.ttf'] if d else []) + [Path('/System/Library/Fonts/Menlo.ttc'), Path('/System/Library/Fonts/SFNSMono.ttf')]
    return serif, italic, mono


def render(args) -> Image.Image:
    c = DARK if args.dark else LIGHT
    serif, italic, mono = fonts(args.font_dir)
    img = Image.new('RGB', (W, H), c['paper'])
    d = ImageDraw.Draw(img)
    x0 = 160
    f_meta = font(mono, 26)
    # doc-meta strip, like the site's masthead
    d.text((x0, 96), 'VON CASTRO  ·  AUTOMATION DEMO', font=f_meta, fill=c['ink3'])
    if args.meta:
        w = d.textlength(args.meta.upper(), font=f_meta)
        d.text((W - x0 - w, 96), args.meta.upper(), font=f_meta, fill=c['ink3'])
    d.line([(x0, 146), (W - x0, 146)], fill=c['rule'], width=2)

    lines = args.title.replace('\\n', '\n').split('\n')
    size = 150 if max(len(l) for l in lines) <= 18 else 116
    f_title, f_italic = font(serif, size), font(italic, size)
    lh = int(size * 1.02)
    block = lh * len(lines)
    y = (H - block) // 2 - (40 if args.sub else 0)
    if args.kicker:
        f_k = font(mono, 30)
        d.line([(x0, y - 52), (x0 + 56, y - 52)], fill=c['accent'], width=3)
        d.text((x0 + 76, y - 70), args.kicker.upper(), font=f_k, fill=c['accent'])
    for line in lines:
        plain, _, accent = line.partition('|')
        d.text((x0, y), plain, font=f_title, fill=c['ink'])
        if accent:
            d.text((x0 + d.textlength(plain, font=f_title), y), accent, font=f_italic, fill=c['accent'])
        y += lh
    y += 40
    d.line([(x0, y), (x0 + 160, y)], fill=c['accent'], width=6)
    if args.sub:
        d.text((x0, y + 40), args.sub, font=font(mono, 44), fill=c['ink'])
    return img


def duration(p):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(p)],
                         capture_output=True, text=True, check=True).stdout
    return float(out.strip())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('out')
    ap.add_argument('--title', required=True)
    ap.add_argument('--kicker')
    ap.add_argument('--sub')
    ap.add_argument('--meta', help='right side of the top strip, e.g. "Speed-to-Lead"')
    ap.add_argument('--secs', type=float, default=1.0)
    ap.add_argument('--voice')
    ap.add_argument('--delay', type=float, default=0.3)
    ap.add_argument('--dark', action='store_true')
    ap.add_argument('--png')
    ap.add_argument('--font-dir')
    args = ap.parse_args()

    png = Path(args.png) if args.png else Path(args.out).with_suffix('.png')
    render(args).save(png)
    secs = args.secs
    cmd = ['ffmpeg', '-v', 'error', '-y', '-loop', '1', '-framerate', '30', '-i', str(png)]
    if args.voice:
        secs = max(secs, args.delay + duration(args.voice) + 0.6)
        ms = int(args.delay * 1000)
        cmd += ['-i', args.voice, '-filter_complex',
                f'[1:a]adelay={ms}|{ms},aresample=44100,aformat=channel_layouts=stereo,apad[a]', '-map', '0:v', '-map', '[a]']
    else:
        cmd += ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-map', '0:v', '-map', '1:a']
    cmd += ENC + ['-t', f'{secs:.3f}', '-movflags', '+faststart', args.out]
    subprocess.run(cmd, check=True)
    print(f'{args.out} {secs:.2f} s (still: {png})')


if __name__ == '__main__':
    sys.exit(main())
