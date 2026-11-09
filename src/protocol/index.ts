/**
 * The PairPilot response protocol.
 *
 * One import site for everything that reads or writes the AI contract:
 *
 *  - `types.ts`       the canonical, versioned message contract
 *  - `schema.ts`      runtime validation with per-field diagnostics
 *  - `adapt.ts`       rewriting any older or differently-shaped reply into it
 *  - `parse.ts`       extracting a JSON payload from whatever text arrived
 *  - `classify.ts`    deciding which type a turn should ask for
 *  - `mode.ts`        workflow modes, intention classification, and the policy
 *                     that keeps planning turns from becoming code proposals
 *  - `diagnostics.ts` a bounded, redacting record of recent replies
 */

export * from './types';
export * from './schema';
export * from './adapt';
export * from './parse';
export * from './classify';
export * from './mode';
export * from './diagnostics';
