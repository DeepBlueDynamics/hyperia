"""
Kokoro Voices Manager & Extractor.
Extracts individual voice vectors from voices-v1.0.bin and voices-v1.1-zh.bin,
categorizes them by language/gender, and provides utilities for voice blending.
"""

from pathlib import Path
import numpy as np

VOICE_METADATA = {
    # American Female
    "af_alloy": {"lang": "en-us", "gender": "Female", "accent": "American", "name": "Alloy"},
    "af_aoede": {"lang": "en-us", "gender": "Female", "accent": "American", "name": "Aoede"},
    "af_bella": {"lang": "en-us", "gender": "Female", "accent": "American", "name": "Bella"},
    "af_heart": {"lang": "en-us", "gender": "Female", "accent": "American", "name": "Heart (Flagship)"},
    "af_jessica": {"lang": "en-us", "gender": "Female", "accent": "American", "name": "Jessica"},
    "af_kore": {"lang": "en-us", "gender": "Female", "accent": "American", "name": "Kore"},
    "af_nicole": {"lang": "en-us", "gender": "Female", "accent": "American", "name": "Nicole"},
    "af_nova": {"lang": "en-us", "gender": "Female", "accent": "American", "name": "Nova"},
    "af_river": {"lang": "en-us", "gender": "Female", "accent": "American", "name": "River"},
    "af_sarah": {"lang": "en-us", "gender": "Female", "accent": "American", "name": "Sarah"},
    "af_sky": {"lang": "en-us", "gender": "Female", "accent": "American", "name": "Sky"},
    # American Male
    "am_adam": {"lang": "en-us", "gender": "Male", "accent": "American", "name": "Adam"},
    "am_echo": {"lang": "en-us", "gender": "Male", "accent": "American", "name": "Echo"},
    "am_eric": {"lang": "en-us", "gender": "Male", "accent": "American", "name": "Eric"},
    "am_fenrir": {"lang": "en-us", "gender": "Male", "accent": "American", "name": "Fenrir"},
    "am_liam": {"lang": "en-us", "gender": "Male", "accent": "American", "name": "Liam"},
    "am_michael": {"lang": "en-us", "gender": "Male", "accent": "American", "name": "Michael"},
    "am_onyx": {"lang": "en-us", "gender": "Male", "accent": "American", "name": "Onyx"},
    "am_puck": {"lang": "en-us", "gender": "Male", "accent": "American", "name": "Puck"},
    "am_santa": {"lang": "en-us", "gender": "Male", "accent": "American", "name": "Santa"},
    # British Female
    "bf_alice": {"lang": "en-gb", "gender": "Female", "accent": "British", "name": "Alice"},
    "bf_emma": {"lang": "en-gb", "gender": "Female", "accent": "British", "name": "Emma"},
    "bf_isabella": {"lang": "en-gb", "gender": "Female", "accent": "British", "name": "Isabella"},
    "bf_lily": {"lang": "en-gb", "gender": "Female", "accent": "British", "name": "Lily"},
    # British Male
    "bm_daniel": {"lang": "en-gb", "gender": "Male", "accent": "British", "name": "Daniel"},
    "bm_fable": {"lang": "en-gb", "gender": "Male", "accent": "British", "name": "Fable"},
    "bm_george": {"lang": "en-gb", "gender": "Male", "accent": "British", "name": "George"},
    "bm_lewis": {"lang": "en-gb", "gender": "Male", "accent": "British", "name": "Lewis"},
    # Spanish
    "ef_dora": {"lang": "es", "gender": "Female", "accent": "Spanish", "name": "Dora"},
    "em_alex": {"lang": "es", "gender": "Male", "accent": "Spanish", "name": "Alex"},
    "em_santa": {"lang": "es", "gender": "Male", "accent": "Spanish", "name": "Santa (ES)"},
    # French
    "ff_siwis": {"lang": "fr-fr", "gender": "Female", "accent": "French", "name": "Siwis"},
    # Hindi
    "hf_alpha": {"lang": "hi", "gender": "Female", "accent": "Hindi", "name": "Alpha"},
    "hf_beta": {"lang": "hi", "gender": "Female", "accent": "Hindi", "name": "Beta"},
    "hm_omega": {"lang": "hi", "gender": "Male", "accent": "Hindi", "name": "Omega"},
    "hm_psi": {"lang": "hi", "gender": "Male", "accent": "Hindi", "name": "Psi"},
    # Italian
    "if_sara": {"lang": "it", "gender": "Female", "accent": "Italian", "name": "Sara"},
    "im_nicola": {"lang": "it", "gender": "Male", "accent": "Italian", "name": "Nicola"},
    # Japanese
    "jf_alpha": {"lang": "ja", "gender": "Female", "accent": "Japanese", "name": "Alpha (JA)"},
    "jf_gongitsune": {"lang": "ja", "gender": "Female", "accent": "Japanese", "name": "Gongitsune"},
    "jf_nezumi": {"lang": "ja", "gender": "Female", "accent": "Japanese", "name": "Nezumi"},
    "jf_tebukuro": {"lang": "ja", "gender": "Female", "accent": "Japanese", "name": "Tebukuro"},
    "jm_kumo": {"lang": "ja", "gender": "Male", "accent": "Japanese", "name": "Kumo"},
    # Brazilian Portuguese
    "pf_dora": {"lang": "pt-br", "gender": "Female", "accent": "Portuguese", "name": "Dora (PT)"},
    "pm_alex": {"lang": "pt-br", "gender": "Male", "accent": "Portuguese", "name": "Alex (PT)"},
    "pm_santa": {"lang": "pt-br", "gender": "Male", "accent": "Portuguese", "name": "Santa (PT)"},
    # Mandarin Chinese
    "zf_xiaobei": {"lang": "zh", "gender": "Female", "accent": "Chinese", "name": "Xiaobei"},
    "zf_xiaoni": {"lang": "zh", "gender": "Female", "accent": "Chinese", "name": "Xiaoni"},
    "zf_xiaoxiao": {"lang": "zh", "gender": "Female", "accent": "Chinese", "name": "Xiaoxiao"},
    "zf_xiaoyi": {"lang": "zh", "gender": "Female", "accent": "Chinese", "name": "Xiaoyi"},
    "zm_yunjian": {"lang": "zh", "gender": "Male", "accent": "Chinese", "name": "Yunjian"},
    "zm_yunxi": {"lang": "zh", "gender": "Male", "accent": "Chinese", "name": "Yunxi"},
    "zm_yunxia": {"lang": "zh", "gender": "Male", "accent": "Chinese", "name": "Yunxia"},
    "zm_yunyang": {"lang": "zh", "gender": "Male", "accent": "Chinese", "name": "Yunyang"},
}

def extract_all_voices():
    base_dir = Path(__file__).parent
    voices_dir = base_dir / "voices"
    voices_dir.mkdir(exist_ok=True)

    bundles = [base_dir / "voices-v1.0.bin", base_dir / "voices-v1.1-zh.bin"]
    total_extracted = 0

    for bundle in bundles:
        if not bundle.exists():
            continue
        print(f"Loading bundle: {bundle.name}...")
        data = np.load(str(bundle))
        for key in data.files:
            voice_arr = data[key]
            out_file = voices_dir / f"{key}.bin"
            if not out_file.exists():
                # Save raw float32 binary format matching original Kokoro voice embeddings
                voice_arr.astype(np.float32).tofile(str(out_file))
                total_extracted += 1

    print(f"Extracted {total_extracted} voices into {voices_dir}")
    return len(list(voices_dir.glob("*.bin")))

def list_voices():
    extract_all_voices()
    base_dir = Path(__file__).parent
    voices_dir = base_dir / "voices"
    voice_files = sorted(voices_dir.glob("*.bin"))

    print("\n" + "=" * 75)
    print(f"AVAILABLE KOKORO VOICES ({len(voice_files)} total)")
    print("=" * 75)
    print(f"{'Voice ID':<16} | {'Name':<20} | {'Lang':<8} | {'Gender':<8} | {'Accent':<12}")
    print("-" * 75)

    for vf in voice_files:
        vid = vf.stem
        meta = VOICE_METADATA.get(vid, {})
        name = meta.get("name", vid)
        lang = meta.get("lang", vid[:2])
        gender = meta.get("gender", "Female" if "f" in vid[:2] else "Male")
        accent = meta.get("accent", "Unknown")
        print(f"{vid:<16} | {name:<20} | {lang:<8} | {gender:<8} | {accent:<12}")
    print("=" * 75 + "\n")

if __name__ == "__main__":
    list_voices()
