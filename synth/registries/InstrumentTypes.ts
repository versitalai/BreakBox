// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// cross-ref: Barrel module that imports all instrument type spec modules.
// Importing this module ensures all instrument types are registered in
// the InstrumentTypeRegistry before any lookup occurs.
//
// To add a new instrument type:
//   1. Add to InstrumentType enum in SynthConfig.ts
//   2. Add name to instrumentTypeNames array in SynthConfig.ts
//   3. Create a spec module in ./instrumentTypes/
//   4. Import it here

import './instrumentTypes/chip';
import './instrumentTypes/fm';
import './instrumentTypes/noise';
import './instrumentTypes/spectrum';
import './instrumentTypes/drumset';
import './instrumentTypes/harmonics';
import './instrumentTypes/pwm';
import './instrumentTypes/pickedString';
import './instrumentTypes/supersaw';
import './instrumentTypes/customChipWave';
import './instrumentTypes/mod';
import './instrumentTypes/fm6op';
import './instrumentTypes/sampleTrigger';

export { instrumentTypeRegistry, InstrumentTypeSpec, ApplyDefaultsFn } from './InstrumentTypeRegistry';
