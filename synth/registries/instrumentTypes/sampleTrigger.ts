// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// cross-ref: Registers the sampleTrigger instrument type spec.
// Replaces the `case InstrumentType.sampleTrigger:` in Instrument.setTypeAndReset()

import { InstrumentType } from '../../SynthConfig';
import { instrumentTypeRegistry, InstrumentTypeSpec } from '../InstrumentTypeRegistry';
import { Config } from '../../SynthConfig';
import { Instrument } from '../../model';

export const sampleTriggerSpec: InstrumentTypeSpec = {
    type: InstrumentType.sampleTrigger,
    isNoise: false,
    hasSpecialInterval: false,
    isChipLike: false,
    displayName: Config.instrumentTypeNames[InstrumentType.sampleTrigger],
    applyDefaults: (instrument: Instrument, isNoiseChannel: boolean) => {
        instrument.sampleUrl = "";
        instrument.sampleNote = 60;
        instrument.sampleRootKey = 60;
        instrument.sampleGain = 1.0;
        instrument.sampleBuffer = null;
        instrument.sampleSampleRate = 44100;
    },
};

instrumentTypeRegistry.register(sampleTriggerSpec);
