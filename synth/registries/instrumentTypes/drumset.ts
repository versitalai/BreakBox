// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.
// Replaces: `case InstrumentType.drumset:` in Instrument.setTypeAndReset()

import { InstrumentType } from '../../SynthConfig';
import { instrumentTypeRegistry, InstrumentTypeSpec } from '../InstrumentTypeRegistry';
import { Config } from '../../SynthConfig';
import { Instrument } from '../../model';
import { SpectrumWave } from '../../model';

export const drumsetSpec: InstrumentTypeSpec = {
    type: InstrumentType.drumset,
    isNoise: false,
    hasSpecialInterval: true,
    isChipLike: false,
    displayName: Config.instrumentTypeNames[InstrumentType.drumset],
    applyDefaults: (instrument: Instrument, isNoiseChannel: boolean) => {
        instrument.chord = Config.chords.dictionary["simultaneous"].index;
        for (let i: number = 0; i < Config.drumCount; i++) {
            instrument.drumsetEnvelopes[i] = Config.envelopes.dictionary["twang 2"].index;
            if (instrument.drumsetSpectrumWaves[i] == undefined) {
                instrument.drumsetSpectrumWaves[i] = new SpectrumWave(true);
            }
            instrument.drumsetSpectrumWaves[i].reset(isNoiseChannel);
        }
    },
};

instrumentTypeRegistry.register(drumsetSpec);
