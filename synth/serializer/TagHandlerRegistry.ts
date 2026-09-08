// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// cross-ref: Used by Song.toBase64String/fromBase64String in model.ts
//
// Replaces the giant switch(SongTagCode) in Song serialization with a registry
// of TagHandler objects. Each tag handler is responsible for writing/reading
// its own tag code, making it trivial to add new serialization tags without
// editing the monolithic model.ts methods.
//
// CRITICAL: The order of tag writes must be EXACTLY preserved. The registry
// maintains a write-order list that mirrors the original serialization sequence.
// Old parsers throw on unknown tags (default: Error), so new tags are additive.

import { SongTagCode, CharCode, base64IntToCharCode, base64CharCodeToInt } from '../format';
import { Song } from '../model';

/**
 * Writer context passed to tag handlers during URL serialization.
 */
export interface TagWriterContext {
    /** The song being serialized. */
    song: Song;
    /** The output buffer to append base64 characters to. */
    buffer: number[];
}

/**
 * Reader context passed to tag handlers during URL deserialization.
 */
export interface TagReaderContext {
    /** The song being deserialized. */
    song: Song;
    /** The source string being parsed. */
    source: string;
}

/**
 * A handler for a single SongTagCode in the URL serialization format.
 *
 * Each handler implements:
 * - write: append the tag code + payload to the buffer
 * - read: parse the payload and apply to the song
 *
 * The registry ensures handlers are called in the exact order they appeared
 * in the original Song.toBase64String / fromBase64String methods, preserving
 * byte-exact URL compatibility.
 */
export interface TagHandler {
    /** The SongTagCode this handler processes. Must be unique. */
    readonly tagCode: SongTagCode;
    /** Human-readable name for debugging. */
    readonly name: string;
    /** Write the tag + payload to the output buffer. */
    write(ctx: TagWriterContext): void;
    /** Read and apply the tag's payload from the source string. Returns the new read position. */
    read(ctx: TagReaderContext, charIndex: number): number;
}

/**
 * Registry for URL serialization tag handlers.
 *
 * Maintains an ordered list of handlers (for deterministic write order) and
 * a lookup map (for dispatch during reading).
 *
 * To add a new serialization tag:
 *   1. Add the SongTagCode value to the SongTagCode enum in format.ts
 *   2. Create a TagHandler module
 *   3. Register it via register()
 *
 * The write order is determined by registration order, so register in the
 * same order tags appear in the original Song.toBase64String().
 */
export class TagHandlerRegistry {
    private handlers: Map<SongTagCode, TagHandler> = new Map();
    private writeOrder: SongTagCode[] = [];

    /**
     * Register a tag handler. The order of registration determines
     * the write order in the URL output.
     */
    register(handler: TagHandler): void {
        if (this.handlers.has(handler.tagCode)) {
            throw new Error(`TagHandler already registered for SongTagCode: ${handler.name}`);
        }
        this.handlers.set(handler.tagCode, handler);
        this.writeOrder.push(handler.tagCode);
    }

    /**
     * Get the handler for a specific tag code, or undefined if none.
     */
    get(tagCode: SongTagCode): TagHandler | undefined {
        return this.handlers.get(tagCode);
    }

    /**
     * Iterate all handlers in registration (write) order.
     */
    getAllInOrder(): TagHandler[] {
        return this.writeOrder.map(code => this.handlers.get(code)!);
    }

    /**
     * Check if a handler is registered for a tag code.
     */
    has(tagCode: SongTagCode): boolean {
        return this.handlers.has(tagCode);
    }
}

/**
 * The global URL serialization tag handler registry.
 *
 * Tag handlers self-register on import via their modules. The barrel
 * module `synth/serializer/Tags.ts` imports all tag handler modules
 * to ensure they're registered before use.
 *
 * Song.toBase64String/fromBase64String delegate to this registry.
 */
export const tagHandlerRegistry: TagHandlerRegistry = new TagHandlerRegistry();
