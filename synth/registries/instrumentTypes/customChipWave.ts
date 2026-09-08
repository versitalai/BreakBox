// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.
// Replaces: `case InstrumentType.customChipWave:` in Instrument.setTypeAndReset()

import { InstrumentType } from '../../SynthConfig';
import { instrumentTypeRegistry, InstrumentTypeSpec } from '../InstrumentTypeRegistry';
import { Config } from '../../SynthConfig';
import { Instrument } from '../../model';

export const customChipWaveSpec: InstrumentTypeSpec = {
    type: InstrumentType.customChipWave,
    isNoise: false,
    hasSpecialInterval: false,
    isChipLike: true,
    displayName: Config.instrumentTypeNames[InstrumentType.customChipWave],
    applyDefaults: (instrument: Instrument, isNoiseChannel: boolean) => {
        instrument.chipWave = 2;
        instrument.chord = Config.chords.dictionary["arpeggio"].index;
        for (let i: number = 0; i < 64; i++) {
            instrument.customChipWave[i] = 24 - (Math.floor(i * (48 / 64)));
        }
        let sum: number = 0.0;
        for (let i: number = 0; i < instrument.customChipWave.length; i++) {
            sum += instrument.customChipWave[i];
        }
        const average: number = sum / instrument.customChipWave.length;
        let cumulative: number = 0;
        let wavePrev: number = 0;
        for (let i: number = 0; i < instrument.customChipWave.length; i++) {
            cumulative += wavePrev;
            wavePrev = instrument.customChipWave[i] - average;
            instrument.customChipWaveIntegral[i] = cumulative;
        }
        instrument.customChipWaveIntegral[64] = 0.0;
    },
};

instrumentTypeRegistry.register(customChipWaveSpec);
