// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// cross-ref: Registers built-in synth function factories in the SynthFunctionRegistry.
// Replaces the if/else chain in Synth.getInstrumentSynthFunction() (dsp.ts ~5537).
//
// This module is imported by synth/synth.ts (barrel) to ensure factories are
// registered before any synthesis occurs. It breaks the circular dependency
// between SynthFunctionRegistry (which needs to reference Synth static methods)
// and dsp.ts (which needs the registry) by using lazy registration at module
// load time — the registry is populated here, and getInstrumentSynthFunction
// consults it at runtime (well after all modules are loaded).

import { InstrumentType, Config } from '../SynthConfig';
import { synthFunctionRegistry } from './SynthFunctionRegistry';
import { Instrument } from '../model';

// Import the Synth class type for method references.
// We use (Synth as any) to access private static members — this preserves
// exact behavior without modifying visibility modifiers in the original code.
import { Synth } from '../dsp';

// FM instrument: uses JIT-compiled synth function with caching
synthFunctionRegistry.register(InstrumentType.fm, (instrument: Instrument) => {
    const fingerprint: string = instrument.algorithm + "_" + instrument.feedbackType;
    const synthAny = Synth as any;
    if (synthAny.fmSynthFunctionCache[fingerprint] == undefined) {
        const synthSource: string[] = [];
        for (const line of synthAny.fmSourceTemplate) {
            if (line.indexOf("// CARRIER OUTPUTS") != -1) {
                const outputs: string[] = [];
                for (let j: number = 0; j < Config.algorithms[instrument.algorithm].carrierCount; j++) {
                    outputs.push("operator" + j + "Scaled");
                }
                synthSource.push(line.replace("/*operator#Scaled*/", outputs.join(" + ")));
            } else if (line.indexOf("// INSERT OPERATOR COMPUTATION HERE") != -1) {
                for (let j: number = Config.operatorCount - 1; j >= 0; j--) {
                    for (const operatorLine of synthAny.operatorSourceTemplate) {
                        if (operatorLine.indexOf("/* + operator@Scaled*/") != -1) {
                            let modulators = "";
                            for (const modulatorNumber of Config.algorithms[instrument.algorithm].modulatedBy[j]) {
                                modulators += " + operator" + (modulatorNumber - 1) + "Scaled";
                            }
                            const feedbackIndices: ReadonlyArray<number> = Config.feedbacks[instrument.feedbackType].indices[j];
                            if (feedbackIndices.length > 0) {
                                modulators += " + feedbackMult * (";
                                const feedbacks: string[] = [];
                                for (const modulatorNumber of feedbackIndices) {
                                    feedbacks.push("operator" + (modulatorNumber - 1) + "Output");
                                }
                                modulators += feedbacks.join(" + ") + ")";
                            }
                            synthSource.push(operatorLine.replace(/\#/g, j + "").replace("/* + operator@Scaled*/", modulators));
                        } else {
                            synthSource.push(operatorLine.replace(/\#/g, j + ""));
                        }
                    }
                }
            } else if (line.indexOf("#") != -1) {
                for (let j: number = 0; j < Config.operatorCount; j++) {
                    synthSource.push(line.replace(/\#/g, j + ""));
                }
            } else {
                synthSource.push(line);
            }
        }
        const wrappedFmSynth: string = "return (synth, bufferIndex, roundedSamplesPerTick, tone, instrument) => {" + synthSource.join("\n") + "}";
        synthAny.fmSynthFunctionCache[fingerprint] = new Function("Config", "Synth", wrappedFmSynth)(Config, Synth);
    }
    return synthAny.fmSynthFunctionCache[fingerprint];
});

// chip: uses advanced loop controls or standard chip synth
synthFunctionRegistry.register(InstrumentType.chip, (instrument: Instrument) => {
    if (instrument.isUsingAdvancedLoopControls) {
        return (Synth as any).loopableChipSynth;
    }
    return (Synth as any).chipSynth;
});

// customChipWave: reuses chip synth (same wave/unison mechanism)
synthFunctionRegistry.register(InstrumentType.customChipWave, (instrument: Instrument) => {
    if (instrument.isUsingAdvancedLoopControls) {
        return (Synth as any).loopableChipSynth;
    }
    return (Synth as any).chipSynth;
});

// harmonics
synthFunctionRegistry.register(InstrumentType.harmonics, (instrument: Instrument) => {
    return (Synth as any).harmonicsSynth;
});

// PWM
synthFunctionRegistry.register(InstrumentType.pwm, (instrument: Instrument) => {
    return (Synth as any).pulseWidthSynth;
});

// supersaw
synthFunctionRegistry.register(InstrumentType.supersaw, (instrument: Instrument) => {
    return (Synth as any).supersawSynth;
});

// picked string
synthFunctionRegistry.register(InstrumentType.pickedString, (instrument: Instrument) => {
    return (Synth as any).pickedStringSynth;
});

// noise
synthFunctionRegistry.register(InstrumentType.noise, (instrument: Instrument) => {
    return (Synth as any).noiseSynth;
});

// spectrum
synthFunctionRegistry.register(InstrumentType.spectrum, (instrument: Instrument) => {
    return (Synth as any).spectrumSynth;
});

// drumset
synthFunctionRegistry.register(InstrumentType.drumset, (instrument: Instrument) => {
    return (Synth as any).drumsetSynth;
});

// mod
synthFunctionRegistry.register(InstrumentType.mod, (instrument: Instrument) => {
    return (Synth as any).modSynth;
});

// fm6op: uses JIT-compiled synth function with caching (same as fm but with custom algorithm)
synthFunctionRegistry.register(InstrumentType.fm6op, (instrument: Instrument) => {
    const fingerprint: string = instrument.customAlgorithm.name + "_" + instrument.customFeedbackType.name;
    const synthAny = Synth as any;
    if (synthAny.fm6SynthFunctionCache[fingerprint] == undefined) {
        const synthSource: string[] = [];
        for (const line of synthAny.fmSourceTemplate) {
            if (line.indexOf("// CARRIER OUTPUTS") != -1) {
                const outputs: string[] = [];
                for (let j: number = 0; j < instrument.customAlgorithm.carrierCount; j++) {
                    outputs.push("operator" + j + "Scaled");
                }
                synthSource.push(line.replace("/*operator#Scaled*/", outputs.join(" + ")));
            } else if (line.indexOf("// INSERT OPERATOR COMPUTATION HERE") != -1) {
                for (let j: number = Config.operatorCount + 2 - 1; j >= 0; j--) {
                    for (const operatorLine of synthAny.operatorSourceTemplate) {
                        if (operatorLine.indexOf("/* + operator@Scaled*/") != -1) {
                            let modulators = "";
                            for (const modulatorNumber of instrument.customAlgorithm.modulatedBy[j]) {
                                modulators += " + operator" + (modulatorNumber - 1) + "Scaled";
                            }
                            const feedbackIndices: ReadonlyArray<number> = instrument.customFeedbackType.indices[j];
                            if (feedbackIndices.length > 0) {
                                modulators += " + feedbackMult * (";
                                const feedbacks: string[] = [];
                                for (const modulatorNumber of feedbackIndices) {
                                    feedbacks.push("operator" + (modulatorNumber - 1) + "Output");
                                }
                                modulators += feedbacks.join(" + ") + ")";
                            }
                            synthSource.push(operatorLine.replace(/\#/g, j + "").replace("/* + operator@Scaled*/", modulators));
                        } else {
                            synthSource.push(operatorLine.replace(/\#/g, j + ""));
                        }
                    }
                }
            } else if (line.indexOf("#") != -1) {
                for (let j = 0; j < Config.operatorCount + 2; j++) {
                    synthSource.push(line.replace(/\#/g, j + ""));
                }
            } else {
                synthSource.push(line);
            }
        }
        const wrappedFm6Synth: string = "return (synth, bufferIndex, roundedSamplesPerTick, tone, instrument) => {" + synthSource.join("\n") + "}";
        synthAny.fm6SynthFunctionCache[fingerprint] = new Function("Config", "Synth", wrappedFm6Synth)(Config, Synth);
    }
    return synthAny.fm6SynthFunctionCache[fingerprint];
});

export {};
