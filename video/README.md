# Video tooling

The tools that make the demo videos: record a scene, narrate it, render it with captions, add title cards,
then join everything. Plain style: no zoom or pan effects, a drawn cursor with click pulses, and a caption bar.

| Tool | What it does |
|---|---|
| `tools/recweb.cjs` | Records a web page (a local stack, `vondemo.pages.dev` or the Worker) as frames plus an events file. Headless Chrome through Playwright. |
| `tools/tts.py` | Speaks each caption's `say` line with the ElevenLabs voice, at 1.20x. Clips are cached by text, so re-renders are free. |
| `tools/post.py` | Renders one clip at 1920x1080: `--crop x0,y0,x1,y1` fits a panel into the frame, `--voice` adds narration, `--phone` draws a phone frame, `--touch` a finger dot, `--pad` holds the last frame. |
| `tools/card.py` | Chapter, title and closing cards in the site's datasheet look, encoded to join with `post.py` clips. |
| `tools/run.sh` | Runs a Node script with a pinned Playwright, for machines without one installed. |

## Steps

1. **Script first.** Narration and a shot list, approved before recording. The result shows in the first 5 seconds.
2. **Record** each scene: `node tools/recweb.cjs scenes/s1.json build/s1`. A scene file lists `caption`, `goto`, `click`,
   `type` and `wait` steps (see the header of `recweb.cjs`). `goto` only opens local stacks and the demo's own hosts;
   set `RECWEB_ALLOW` to a regex to change that.
3. **Narrate**: `ELEVENLABS_API_KEY=… python3 tools/tts.py build s1 s2 s3` (run it under your secret manager so the
   key never lands in a file or the shell history).
4. **Render** each scene: `python3 tools/post.py build/s1 build/s1.mp4 --voice --crop 0,80,1920,1000`.
   Crop to the panel where the action is, so UI text is at least ~18 px in the final frame.
5. **Cards**: `python3 tools/card.py build/card1.mp4 --kicker "Part 1 of 3" --title "Capture the |lead" --meta "Speed-to-Lead"`
   (1 s by default) and a closing card:
   `python3 tools/card.py build/closing.mp4 --title "Try it |live." --sub vondemo.pages.dev/speed-to-lead --voice build/voice/<clip>.mp3`.
6. **Join**: list the clips in `concat.txt` (`file 'build/s1.mp4'` per line), then
   `ffmpeg -f concat -safe 0 -i concat.txt -c copy -movflags +faststart demo.mp4`.
7. **Review**: a contact sheet, a phone viewing, then Von watches the draft. Upload to YouTube with the `.srt`.

Requirements: Python 3 with Pillow, ffmpeg/ffprobe, and Node with Playwright for recording.
Raw frames, voice clips and renders go in `build/` folders, which git ignores.
