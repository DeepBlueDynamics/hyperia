#!/usr/bin/env python3
"""
A/B Objective Audio Evaluation Suite for Kokoro TTS.
Preserves raw f32 metrics without DAC/WAV quantization distortion.

Calculates:
  - Duration (s) & Duration Ratio
  - Raw f32 Peak Amplitude & Peak dBFS
  - Confirmed Over-Range Samples (|x| > 1.0) & Over-Range Rate (%)
  - Near-Threshold Samples (|x| >= 0.999) & Near-Threshold Rate (%)
  - RMS Energy (dBFS) on raw f32
  - Trailing Silence (ms) (threshold: -40 dBFS / 0.01 amp)
  - End Cutoff Amplitude (last 100 samples mean abs)
  - Spectral Metrics against Reference Audio:
      * Mel-Spectrogram Pearson Correlation (aligned via DTW)
      * Mel-Cepstral Distortion (MCD, in dB)
      * Cosine Similarity
"""

import os
import json
import argparse
import numpy as np
import soundfile as sf
from scipy.spatial.distance import cdist
import librosa

def load_audio_f32(path_or_array, target_sr: int = 24000) -> np.ndarray:
    """Load audio as float32 array at target sample rate."""
    if isinstance(path_or_array, np.ndarray):
        data = path_or_array.astype(np.float32)
        return data
    data, sr = sf.read(path_or_array, dtype="float32")
    if data.ndim > 1:
        data = np.mean(data, axis=1)
    if sr != target_sr:
        data = librosa.resample(data, orig_sr=sr, target_sr=target_sr)
    return data.astype(np.float32)

def compute_raw_f32_metrics(audio: np.ndarray, sr: int = 24000) -> dict:
    """Compute physical acoustic metrics directly on raw f32 audio samples."""
    duration = float(len(audio) / sr)
    if len(audio) == 0:
        return {
            "duration_s": 0.0,
            "peak_f32": 0.0,
            "peak_dbfs": -120.0,
            "over_range_count": 0,
            "over_range_pct": 0.0,
            "near_threshold_count": 0,
            "near_threshold_pct": 0.0,
            "rms_dbfs": -120.0,
            "trailing_silence_ms": 0.0,
            "end_cutoff_amp": 0.0,
        }

    peak_f32 = float(np.max(np.abs(audio)))
    peak_dbfs = float(20.0 * np.log10(max(peak_f32, 1e-6)))

    # Confirmed over-range samples: values exceeding +/-1.0 (will clip in standard DAC/WAV)
    over_range = int(np.sum(np.abs(audio) > 1.0))
    over_range_pct = float(100.0 * over_range / len(audio))

    # Near-threshold samples: values reaching within 0.1% of 1.0
    near_threshold = int(np.sum(np.abs(audio) >= 0.999))
    near_threshold_pct = float(100.0 * near_threshold / len(audio))

    # RMS on unquantized f32
    rms = float(np.sqrt(np.mean(audio ** 2)))
    rms_dbfs = float(20.0 * np.log10(max(rms, 1e-6)))

    # Trailing silence: time from last frame >= 0.01 (-40 dBFS) to the final sample
    threshold = 0.01
    above_thresh = np.where(np.abs(audio) >= threshold)[0]
    if len(above_thresh) > 0:
        last_idx = above_thresh[-1]
        trailing_samples = len(audio) - 1 - last_idx
        trailing_silence_ms = float(trailing_samples / sr * 1000.0)
    else:
        trailing_silence_ms = float(len(audio) / sr * 1000.0)

    # End cutoff amplitude: mean abs of the last 100 samples (tests abrupt drop without tail)
    last_samples = audio[-min(100, len(audio)):]
    end_cutoff_amp = float(np.mean(np.abs(last_samples)))

    return {
        "duration_s": round(duration, 3),
        "peak_f32": round(peak_f32, 4),
        "peak_dbfs": round(peak_dbfs, 2),
        "over_range_count": over_range,
        "over_range_pct": round(over_range_pct, 4),
        "near_threshold_count": near_threshold,
        "near_threshold_pct": round(near_threshold_pct, 4),
        "rms_dbfs": round(rms_dbfs, 2),
        "trailing_silence_ms": round(trailing_silence_ms, 1),
        "end_cutoff_amp": round(end_cutoff_amp, 5),
    }

def compute_spectral_metrics(test_audio: np.ndarray, ref_audio: np.ndarray, sr: int = 24000) -> dict:
    """Compute DTW-aligned Mel-spectral distortion and correlation."""
    if len(test_audio) < 1024 or len(ref_audio) < 1024:
        return {"spectral_correlation": 0.0, "mcd_db": 99.0, "cosine_similarity": 0.0}

    n_fft = 1024
    hop_length = 256
    n_mels = 80

    mel_test = librosa.feature.melspectrogram(y=test_audio, sr=sr, n_fft=n_fft, hop_length=hop_length, n_mels=n_mels)
    mel_ref = librosa.feature.melspectrogram(y=ref_audio, sr=sr, n_fft=n_fft, hop_length=hop_length, n_mels=n_mels)

    log_mel_test = librosa.power_to_db(mel_test, ref=np.max)
    log_mel_ref = librosa.power_to_db(mel_ref, ref=np.max)

    # 13 MFCCs for MCD
    mfcc_test = librosa.feature.mfcc(S=log_mel_test, n_mfcc=13)
    mfcc_ref = librosa.feature.mfcc(S=log_mel_ref, n_mfcc=13)

    # DTW alignment on MFCC distance matrix
    dist_matrix = cdist(mfcc_test.T, mfcc_ref.T, metric="euclidean")
    N, M = dist_matrix.shape
    dtw_cost = np.zeros((N + 1, M + 1))
    dtw_cost[0, 1:] = np.inf
    dtw_cost[1:, 0] = np.inf
    for i in range(1, N + 1):
        for j in range(1, M + 1):
            dtw_cost[i, j] = dist_matrix[i - 1, j - 1] + min(
                dtw_cost[i - 1, j],
                dtw_cost[i, j - 1],
                dtw_cost[i - 1, j - 1]
            )

    i, j = N, M
    path_test, path_ref = [], []
    while i > 0 and j > 0:
        path_test.append(i - 1)
        path_ref.append(j - 1)
        step = np.argmin([dtw_cost[i - 1, j - 1], dtw_cost[i - 1, j], dtw_cost[i, j - 1]])
        if step == 0:
            i -= 1
            j -= 1
        elif step == 1:
            i -= 1
        else:
            j -= 1
    path_test.reverse()
    path_ref.reverse()

    aligned_test_mfcc = mfcc_test[:, path_test]
    aligned_ref_mfcc = mfcc_ref[:, path_ref]

    # MCD in dB (excluding c0)
    diff = aligned_test_mfcc[1:, :] - aligned_ref_mfcc[1:, :]
    frame_mcd = np.sqrt(np.sum(diff ** 2, axis=0))
    mcd = float((10.0 * np.sqrt(2.0) / np.log(10.0)) * np.mean(frame_mcd))

    # Pearson correlation on aligned Mel spectrogram
    aligned_test_mel = log_mel_test[:, path_test].flatten()
    aligned_ref_mel = log_mel_ref[:, path_ref].flatten()

    corr = float(np.corrcoef(aligned_test_mel, aligned_ref_mel)[0, 1])
    if np.isnan(corr):
        corr = 0.0

    # Cosine similarity
    norm_t = np.linalg.norm(aligned_test_mel)
    norm_r = np.linalg.norm(aligned_ref_mel)
    cos_sim = float(np.dot(aligned_test_mel, aligned_ref_mel) / (norm_t * norm_r + 1e-9))

    return {
        "spectral_correlation": round(corr, 4),
        "mcd_db": round(mcd, 2),
        "cosine_similarity": round(cos_sim, 4),
    }

def evaluate_audio(test_audio_or_path, ref_audio_or_path = None, sr: int = 24000) -> dict:
    test_audio = load_audio_f32(test_audio_or_path, target_sr=sr)
    res = compute_raw_f32_metrics(test_audio, sr=sr)
    if ref_audio_or_path is not None:
        ref_audio = load_audio_f32(ref_audio_or_path, target_sr=sr)
        spec = compute_spectral_metrics(test_audio, ref_audio, sr=sr)
        res.update(spec)
        ref_dur = len(ref_audio) / float(sr)
        res["duration_ratio"] = round(float(res["duration_s"] / max(ref_dur, 1e-3)), 3)
    return res

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--test", required=True, help="Test WAV path")
    parser.add_argument("--ref", default=None, help="Reference WAV path")
    args = parser.parse_args()
    result = evaluate_audio(args.test, args.ref)
    print(json.dumps(result, indent=2))
