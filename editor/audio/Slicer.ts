// BreakBox Phase 2: transient auto-slicing utility.
// Analyzes a sample for onset peaks and returns slice boundaries (sample indices).

// Detects slice points in a waveform. Returns an array of boundary sample
// indices [0, s1, s2, ..., length]. Uses an energy-based onset detector:
// the signal is windowed, short-term energy is computed, and boundaries are
// placed at local energy peaks that exceed a threshold relative to the mean.
export function detectTransients(samples: Float32Array | number[], sliceCount: number, minSliceSamples: number = 512): number[] {
    if (samples.length <= 0) return [0];
    if (sliceCount <= 1) return [0, samples.length];

    const windowSize: number = Math.max(64, Math.min(4096, Math.floor(samples.length / 64)));
    const hop: number = Math.max(32, Math.floor(windowSize / 2));
    const windowCount: number = Math.max(2, Math.floor((samples.length - windowSize) / hop) + 1);

    // Compute short-term energy per window.
    const energies: number[] = [];
    for (let w = 0; w < windowCount; w++) {
        const offset: number = w * hop;
        let energy: number = 0;
        for (let i = 0; i < windowSize; i++) {
            const s: number = samples[offset + i];
            energy += s * s;
        }
        energies.push(energy / windowSize);
    }

    // Normalize and find the mean + peak.
    let sum: number = 0;
    let peak: number = 0;
    for (const e of energies) {
        sum += e;
        if (e > peak) peak = e;
    }
    const mean: number = sum / energies.length;
    if (peak <= 0 || mean <= 0) {
        // Silence: just split evenly.
        const boundaries: number[] = [0];
        for (let i = 1; i < sliceCount; i++) {
            boundaries.push(Math.floor(samples.length * i / sliceCount));
        }
        boundaries.push(samples.length);
        return boundaries;
    }

    // Threshold: energy peaks above this are transients. Use a fraction of the
    // range between mean and peak so quiet material still slices sensibly.
    const threshold: number = mean + (peak - mean) * 0.25;

    // Find candidate onsets: windows where energy rises above threshold and is
    // a local max within a small neighborhood.
    const candidates: number[] = [];
    const radius: number = Math.max(1, Math.floor(windowCount / (sliceCount * 3)));
    for (let w = 1; w < windowCount - 1; w++) {
        if (energies[w] >= threshold && energies[w] >= energies[w - 1] && energies[w] >= energies[w + 1]) {
            // Local max; suppress nearby candidates.
            let isDominant: boolean = true;
            for (let r = 1; r <= radius; r++) {
                if (energies[w + r] > energies[w]) { isDominant = false; break; }
            }
            if (isDominant) {
                candidates.push(w * hop + Math.floor(windowSize / 2));
            }
        }
    }

    // If we don't have enough candidates, split evenly between the found ones.
    // Select up to sliceCount-1 boundaries, evenly spaced across candidates.
    const boundaries: number[] = [0];
    if (candidates.length > 0) {
        const targetCount: number = Math.min(sliceCount - 1, candidates.length);
        // Pick evenly spaced candidates.
        for (let i = 0; i < targetCount; i++) {
            const idx: number = Math.floor((i + 1) * candidates.length / (targetCount + 1)) - 1;
            const boundary: number = candidates[Math.max(0, Math.min(candidates.length - 1, idx))];
            if (boundary > boundaries[boundaries.length - 1] && boundary < samples.length - 1) {
                boundaries.push(boundary);
            }
        }
    }
    // Fallback: ensure we have enough boundaries (even split for gaps).
    while (boundaries.length < sliceCount) {
        const last: number = boundaries[boundaries.length - 1];
        const remaining: number = samples.length - last;
        const next: number = last + Math.floor(remaining / (sliceCount - boundaries.length + 1));
        if (next <= last || next >= samples.length) break;
        boundaries.push(next);
    }
    boundaries.push(samples.length);

    // Sort + dedupe.
    boundaries.sort((a, b) => a - b);
    const unique: number[] = [];
    for (const b of boundaries) {
        if (unique.length === 0 || b > unique[unique.length - 1] + minSliceSamples) {
            unique.push(b);
        }
    }
    if (unique[unique.length - 1] !== samples.length) unique.push(samples.length);
    return unique;
}
