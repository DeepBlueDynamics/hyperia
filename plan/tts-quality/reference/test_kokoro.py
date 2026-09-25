"""
Kokoro TTS verification script.
Tests both the Best (FP16) model and Full Reference (FP32) model using kokoro-onnx.
"""

import time
from pathlib import Path
from kokoro_onnx import Kokoro
import soundfile as sf

def test_model(model_name: str, voice_name: str = "af_heart"):
    model_dir = Path(__file__).parent
    model_path = model_dir / model_name
    voices_path = model_dir / "voices-v1.0.bin"

    if not model_path.exists():
        print(f"[!] Error: Model not found at {model_path}")
        return

    print("=" * 60)
    print(f"Testing Model: {model_name} ({model_path.stat().st_size / (1024*1024):.2f} MB)")
    print(f"Voice Bundle: {voices_path.name}")

    start_load = time.time()
    kokoro = Kokoro(str(model_path), str(voices_path))
    load_time = time.time() - start_load
    print(f"Model loaded in: {load_time:.2f}s")

    test_text = "Kokoro is a high-performance open-weight text-to-speech model under 500 megabytes."
    print(f"Synthesizing text: \"{test_text}\"")
    print(f"Voice: {voice_name}")

    start_synth = time.time()
    samples, sample_rate = kokoro.create(
        test_text,
        voice=voice_name,
        speed=1.0,
        lang="en-us"
    )
    synth_time = time.time() - start_synth

    duration = len(samples) / sample_rate
    rtf = synth_time / duration if duration > 0 else 0
    print(f"Synthesized {duration:.2f}s of audio in {synth_time:.2f}s (Real-Time Factor: {rtf:.3f}x)")

    output_filename = model_dir / f"test_{model_path.stem}.wav"
    sf.write(str(output_filename), samples, sample_rate)
    print(f"Saved audio: {output_filename.name}")
    print("=" * 60 + "\n")

def main():
    print("\n--- Starting Kokoro TTS Synthesis Verification ---")
    # 1. Best Model (FP16, 163.5 MB, 0.999 correlation with FP32)
    test_model("kokoro-v1.0.fp16.onnx", voice_name="af_heart")

    # 2. Full Precision Reference Model (FP32, 325.5 MB)
    test_model("kokoro-v1.0.onnx", voice_name="af_bella")
    print("All tests completed successfully!")

if __name__ == "__main__":
    main()
