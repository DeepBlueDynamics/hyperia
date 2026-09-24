"""
Kokoro TTS Integrated CLI & Speech Synthesizer.
Supports all 54+ voices, voice blending, speed adjustments, and direct audio playback.
"""

import argparse
import sys
import time
from pathlib import Path
import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro
from voice_manager import VOICE_METADATA, extract_all_voices

BASE_DIR = Path(__file__).parent
DEFAULT_MODEL = BASE_DIR / "kokoro-v1.0.fp16.onnx"
VOICES_BUNDLE = BASE_DIR / "voices-v1.0.bin"
VOICES_DIR = BASE_DIR / "voices"

def load_voice(voice_spec: str, kokoro: Kokoro) -> np.ndarray:
    """
    Load a voice or blend multiple voices (e.g. 'af_heart' or 'af_heart:0.6,am_adam:0.4')
    """
    if "," in voice_spec or ":" in voice_spec:
        # Voice blending
        parts = voice_spec.split(",")
        blended = None
        total_weight = 0.0
        for part in parts:
            if ":" in part:
                vname, weight_str = part.split(":")
                weight = float(weight_str)
            else:
                vname = part
                weight = 1.0

            vname = vname.strip()
            v_arr = kokoro.get_voice_style(vname)
            if blended is None:
                blended = v_arr * weight
            else:
                blended += v_arr * weight
            total_weight += weight

        return blended / total_weight
    else:
        return kokoro.get_voice_style(voice_spec.strip())

def synthesize(
    text: str,
    voice: str = "af_heart",
    model_path: Path = DEFAULT_MODEL,
    speed: float = 1.0,
    lang: str = "en-us",
    output_file: Path | None = None,
    play: bool = False
):
    if not model_path.exists():
        print(f"[!] Error: Model not found at {model_path}")
        sys.exit(1)

    print(f"Loading Kokoro ({model_path.name})...")
    start = time.time()
    kokoro = Kokoro(str(model_path), str(VOICES_BUNDLE))
    print(f"Model ready in {time.time() - start:.2f}s")

    print(f"Synthesizing with voice: '{voice}' at speed {speed}x...")
    style = load_voice(voice, kokoro)

    t0 = time.time()
    samples, sample_rate = kokoro.create(
        text,
        voice=style,
        speed=speed,
        lang=lang
    )
    t_synth = time.time() - t0
    duration = len(samples) / sample_rate
    print(f"Generated {duration:.2f}s audio in {t_synth:.2f}s (RTF: {t_synth/duration:.3f}x)")

    if output_file is None:
        clean_voice = voice.replace(":", "_").replace(",", "_")
        output_file = BASE_DIR / f"kokoro_{clean_voice}.wav"

    sf.write(str(output_file), samples, sample_rate)
    print(f"[+] Saved audio to: {output_file.name}")

    if play:
        play_audio(output_file)

    return output_file

def play_audio(filepath: Path):
    """Plays audio on host machine via PowerShell System.Media.SoundPlayer"""
    import subprocess
    print(f"[*] Playing {filepath.name} aloud...")
    cmd = [
        "powershell.exe",
        "-NoProfile",
        "-Command",
        f'(New-Object System.Media.SoundPlayer "{filepath.resolve()}").PlaySync()'
    ]
    try:
        subprocess.run(cmd, check=True)
    except Exception as e:
        print(f"Playback notice: {e}")

def main():
    parser = argparse.ArgumentParser(description="Kokoro TTS Integrated Tool")
    parser.add_argument("text", nargs="?", default=None, help="Text to speak")
    parser.add_argument("--voice", "-v", default="af_heart", help="Voice ID or blend (e.g. 'af_heart' or 'af_heart:0.5,am_adam:0.5')")
    parser.add_argument("--speed", "-s", type=float, default=1.0, help="Speech speed multiplier (default: 1.0)")
    parser.add_argument("--lang", "-l", default="en-us", help="Language code (e.g. 'en-us', 'en-gb', 'ja', 'zh', 'es', 'fr')")
    parser.add_argument("--model", "-m", choices=["fp16", "fp32", "q8f16"], default="fp16", help="Model precision variant")
    parser.add_argument("--out", "-o", type=Path, default=None, help="Output wav filename")
    parser.add_argument("--play", "-p", action="store_true", help="Play audio immediately after generation")
    parser.add_argument("--list", action="store_true", help="List all available voices and accents")

    args = parser.parse_args()

    if args.list:
        from voice_manager import list_voices
        list_voices()
        return

    if not args.text:
        print("Usage: python tts.py \"Your text to speak\" [--voice af_heart] [--play]")
        print("Run 'python tts.py --list' to see all 54 voices.")
        return

    model_map = {
        "fp16": BASE_DIR / "kokoro-v1.0.fp16.onnx",
        "fp32": BASE_DIR / "kokoro-v1.0.onnx",
        "q8f16": BASE_DIR / "kokoro-v1.0-q8f16.onnx",
    }
    model_path = model_map[args.model]

    synthesize(
        text=args.text,
        voice=args.voice,
        model_path=model_path,
        speed=args.speed,
        lang=args.lang,
        output_file=args.out,
        play=args.play
    )

if __name__ == "__main__":
    main()
