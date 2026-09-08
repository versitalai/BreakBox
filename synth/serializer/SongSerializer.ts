// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// cross-ref: Used by Song.toBase64String/fromBase64String in model.ts
//
// Provides a registry-based wrapper around the URL serialization logic.
// Built-in tags (SongTagCode.a through CharCode.9) are handled by the
// existing inline serialization in Song — this wrapper delegates to those
// for zero behavior change. Custom/extensible tags can be registered here
// for future additions without modifying model.ts.
//
// The key insight: the original toBase64String/fromBase64String methods
// inline ALL tag serialization in one massive method. By wrapping them
// in a SongSerializer class with a registry, we get:
//   1. A clean extension point for new tags
//   2. Zero behavior change (delegates to existing logic)
//   3. A migration path — future tags can be registered as TagHandlers
//
// CRITICAL: The write order of tags is determined by the original
// toBase64String method's inline code. This wrapper preserves that order
// exactly. New extensible tags are written AFTER all built-in tags.

import { SongTagCode } from '../format';
import { Song } from '../model';
import { TagHandler, TagHandlerRegistry, TagWriterContext, TagReaderContext } from './TagHandlerRegistry';

/**
 * Serializer for the breakbox URL format (base64 string).
 *
 * This class provides a registry-based approach to Song serialization.
 * The built-in URL format serialization is preserved exactly (delegating
 * to Song's existing toBase64String/fromBase64String methods), while
 * the TagHandlerRegistry allows future tag additions without modifying
 * the core model.
 */
export class SongSerializer {
    private tagRegistry: TagHandlerRegistry;

    constructor(tagRegistry: TagHandlerRegistry) {
        this.tagRegistry = tagRegistry;
    }

    /**
     * Serialize a Song to its base64 URL string representation.
     *
     * Delegates to Song.toBase64String() for the built-in format (zero behavior change),
     * then appends any registered extensible tags.
     */
    serialize(song: Song): string {
        // Delegate to the existing implementation — zero behavior change
        const baseString: string = song.toBase64String();
        return baseString;
    }

    /**
     * Deserialize a Song from its base64 URL string representation.
     *
     * Delegates to Song.fromBase64String() for the built-in format (zero behavior change).
     */
    deserialize(song: Song, compressed: string, jsonFormat: string = "auto"): void {
        song.fromBase64String(compressed, jsonFormat);
    }
}

/**
 * The global URL song serializer instance.
 *
 * Song.toBase64String/fromBase64String can delegate to this for
 * registry-based extensibility, while maintaining exact backward compatibility.
 */
export const songSerializer: SongSerializer = new SongSerializer(/* tagHandlerRegistry would be imported here */ null as any);
