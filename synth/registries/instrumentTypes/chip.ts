// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// cross-ref: Registers the chip instrument type spec.
// Replaces the `case InstrumentType.chip:` in Instrument.setTypeAndReset()

import { InstrumentType } from '../../SynthConfig';
import { instrumentTypeRegistry, InstrumentTypeSpec } from '../InstrumentTypeRegistry';
import { Config } from '../../SynthConfig';
import { Instrument } from '../../model';

export const chipSpec: InstrumentTypeSpec = {
    type: InstrumentType.chip,
    isNoise: false,
    hasSpecialInterval: false,
    isChipLike: true,
    displayName: Config.instrumentTypeNames[InstrumentType.chip],
    applyDefaults: (instrument: Instrument, isNoiseChannel: boolean) => {
        instrument.chipWave = 2;
        instrument.chord = Config.chords.dictionary["arpeggio"].index;
        instrument.isUsingAdvancedLoopControls = false;
        instrument.chipWaveLoopStart = 0;
        instrument.chipWaveLoopEnd = Config.rawRawChipWaves[instrument.chipWave].samples.length - 1;
        instrument.chipWaveLoopMode = 0;
        instrument.chipWavePlayBackwards = false;
        instrument.chipWaveStartOffset = 0;
    },
};

instrumentTypeRegistry.register(chipSpec);
