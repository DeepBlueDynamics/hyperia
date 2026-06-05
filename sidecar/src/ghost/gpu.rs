use std::process::Command;

/// Detect total GPU VRAM in gigabytes.
/// Queries nvidia-smi for dedicated GPUs, falls back to macOS sysctl hw.memsize
/// (unified memory), and Linux /proc/meminfo as system fallbacks.
pub fn get_gpu_vram_gb() -> Option<u64> {
    // Try nvidia-smi first (Linux/Windows)
    if let Ok(output) = Command::new("nvidia-smi")
        .args(&["--query-gpu=memory.total", "--format=csv,noheader,nounits"])
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(vram_mb) = stdout.lines().next().and_then(|l| l.trim().parse::<u64>().ok()) {
                return Some((vram_mb + 512) / 1024); // Round to nearest GB
            }
        }
    }
    
    // On macOS, Apple Silicon uses unified memory, so query system RAM
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = Command::new("sysctl")
            .args(&["-n", "hw.memsize"])
            .output()
        {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Ok(bytes) = stdout.trim().parse::<u64>() {
                    return Some(bytes / (1024 * 1024 * 1024));
                }
            }
        }
    }

    // On Linux, check system RAM as fallback
    #[cfg(target_os = "linux")]
    {
        if let Ok(mem_info) = std::fs::read_to_string("/proc/meminfo") {
            for line in mem_info.lines() {
                if line.starts_with("MemTotal:") {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() >= 2 {
                        if let Ok(kb) = parts[1].parse::<u64>() {
                            return Some(kb / (1024 * 1024)); // Convert KB to GB
                        }
                    }
                }
            }
        }
    }

    None
}

/// Automatically trigger pulling the optimal Ollama model based on VRAM capacity.
/// - VRAM <= 8GB: triggers gemma4:e2b
/// - VRAM > 8GB: triggers gemma4:12b
pub fn trigger_ollama_pull(url: &str, vram: u64, installed_models: &[String]) -> (String, bool) {
    let model = if vram <= 8 {
        "gemma4:e2b".to_string()
    } else {
        "gemma4:12b".to_string()
    };
    
    let is_installed = installed_models.iter().any(|m| m.contains(&model) || m.starts_with(&model));
    let mut download_triggered = false;
    if !is_installed {
        download_triggered = true;
        let pull_url = format!("{}/api/pull", url.trim_end_matches('/'));
        let target = model.clone();
        tokio::spawn(async move {
            let c = reqwest::Client::new();
            let _ = c.post(pull_url)
                .json(&serde_json::json!({
                    "name": target,
                    "stream": false
                }))
                .send()
                .await;
        });
    }
    
    (model, download_triggered)
}
