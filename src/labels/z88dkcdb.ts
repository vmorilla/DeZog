/**
 * Decoding of the sdcc CDB debug records that z88dk ("-debug") writes into
 * the map file as constant symbols, e.g.
 *   __CDBINFO__S_3aG_24player_240_5f0_240_28_7b13_7dSTsprite_3aS_29_2cE_2c0_2c0 = $0001 ; ...
 * The record text is the symbol name after the prefix, every character that
 * is not a letter or digit escaped as "_xx" (hex), i.e. the example decodes to
 *   S:G$player$0_0$0({13}STsprite:S),E,0,0
 *
 * Record kinds (see design/c-variables.md, section 2):
 *   M:<module>                                       module
 *   F:<scope>$<name>$<lvl>_<sub>$<block>(<type>),C,…   function
 *   S:<scope>$<name>$<lvl>_<sub>$<block>(<type>),<space>,<onStack>,<offset>[,[<regs>]]
 *   T:F<module>$<tag>[({<offset>}S:S$<member>$0_0$0(<type>),Z,0,0)…]
 * Scope: "G" global, "F<module>" file static, "L<module>.<function>" (or
 * "L<function>") local.
 * Type: "{<size>}" followed by a comma separated chain of declarators
 * (DA<n>d array, DG/DC/DX/DD/DP/DI pointer, DF function) and one specifier
 * (SC char, SS short, SI int, SL long, SLL long long, SF float, SV void,
 * ST<tag> struct/union, SB<offset>$<width> bitfield, empty for _Bool) with
 * ":S" (signed) or ":U" (unsigned).
 */


/** The prefix of the CDB symbols in the map file. */
export const CDB_SYMBOL_PREFIX = '__CDBINFO__';


/** A C type, decoded from a CDB type chain. */
export type CType =
	{kind: 'int', size: number, signed: boolean, isChar: boolean, isBool?: boolean} |
	{kind: 'float', size: number} |
	{kind: 'void'} |
	{kind: 'pointer', target: CType} |
	{kind: 'array', length: number, elem: CType, size: number} |
	{kind: 'function', ret: CType} |
	{kind: 'struct', tag: string} |
	{kind: 'bitfield', bitOffset: number, bitWidth: number, signed: boolean} |
	{kind: 'unknown', size: number, text: string};


/** A symbol record ("S:"), also used for the function records ("F:"). */
export interface CdbSymbol {
	/// 'G' global, 'F' file static, 'L' local (incl. parameters and function statics).
	scope: 'G' | 'F' | 'L';
	/// The C module for 'F' (e.g. "vars"), and for 'L' if given.
	cModule?: string;
	/// The function of a local ('L'), e.g. "sum_points".
	func?: string;
	/// The C name, e.g. "player".
	name: string;
	/// Nesting level, sub-level and block number.
	level: number;
	subLevel: number;
	block: number;
	/// The decoded type.
	type: CType;
	/// The size in bytes of the whole type, from "{size}".
	size: number;
	/// The address space: 'E' static, 'B' stack, 'R' register, 'C' code, 'Z' none, ...
	addressSpace: string;
	/// True if on the stack ('B').
	onStack: boolean;
	/// The stack offset relative to the frame pointer (for 'B').
	stackOffset: number;
	/// The registers (for 'R'), e.g. ['e', 'd'] (least significant first).
	registers?: string[];
}


/** A struct/union member from a "T:" record. */
export interface CdbMember {
	name: string;
	offset: number;
	type: CType;
	size: number;
}


/** A type record ("T:"). */
export interface CdbStruct {
	cModule: string;
	tag: string;
	members: CdbMember[];
}


/** A decoded record. */
export type CdbRecord =
	{kind: 'module', name: string} |
	{kind: 'symbol', symbol: CdbSymbol} |
	{kind: 'function', symbol: CdbSymbol} |
	{kind: 'type', struct: CdbStruct};


/** Decodes the escaped record text of a map symbol name.
 * @param encoded The part after "__CDBINFO__", e.g. "S_3aG_24player_24..."
 * @returns E.g. "S:G$player$..."
 */
export function decodeCdbSymbolName(encoded: string): string {
	return encoded.replace(/_([0-9a-fA-F]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}


/** Size of a specifier in bytes (the Z80 sizes of sdcc), or undefined for
 * struct/void/unknown (the size is then taken from elsewhere). */
function specSize(spec: string): number | undefined {
	if (spec.startsWith('SLL'))
		return 8;
	switch (spec.substring(0, 2)) {
		case 'SC': return 1;
		case 'SS': return 2;
		case 'SI': return 2;
		case 'SL': return 4;
		case 'SF': return 4;
	}
	return undefined;
}


/** Decodes the specifier, e.g. "SI:S", "STpoint:S", "SB3$2:U".
 * @param spec The specifier.
 * @param size The size if known from the type chain (used for float and unknown).
 */
function parseSpecifier(spec: string, size: number | undefined): CType {
	const colon = spec.lastIndexOf(':');
	const sign = (colon >= 0) ? spec.substring(colon + 1) : 'S';
	const name = (colon >= 0) ? spec.substring(0, colon) : spec;
	const signed = (sign !== 'U');
	if (name.startsWith('ST'))
		return {kind: 'struct', tag: name.substring(2)};
	const bitfield = /^SB(\d+)\$(\d+)$/.exec(name);
	if (bitfield)
		return {kind: 'bitfield', bitOffset: parseInt(bitfield[1]), bitWidth: parseInt(bitfield[2]), signed};
	if (name === 'SV')
		return {kind: 'void'};
	if (name === '')
		return {kind: 'int', size: size ?? 1, signed: false, isChar: false, isBool: true};	// _Bool, e.g. '{1}:S'
	if (name === 'SF')
		return {kind: 'float', size: size ?? 4};
	if (name === 'SLL')
		return {kind: 'int', size: 8, signed, isChar: false};
	const intSize = specSize(name);
	if (intSize !== undefined)
		return {kind: 'int', size: intSize, signed, isChar: name === 'SC'};
	return {kind: 'unknown', size: size ?? 0, text: spec};
}


/** Decodes a declarator/specifier chain, starting at index.
 * @param parts E.g. ['DA3d', 'STpoint:S'].
 * @param index The start index.
 * @param size The size of this (sub) type, if known.
 */
function parseChain(parts: string[], index: number, size: number | undefined): CType {
	const part = parts[index];
	if (part === undefined)
		return {kind: 'unknown', size: size ?? 0, text: ''};
	if (index === parts.length - 1)
		return parseSpecifier(part, size);
	const array = /^DA(\d+)d$/.exec(part);
	if (array) {
		const length = parseInt(array[1]);
		const elemSize = (size !== undefined && length > 0) ? size / length : undefined;
		return {kind: 'array', length, elem: parseChain(parts, index + 1, elemSize), size: size ?? 0};
	}
	if (part === 'DF')
		return {kind: 'function', ret: parseChain(parts, index + 1, undefined)};
	if (/^D[GCXDPI]$/.test(part))
		return {kind: 'pointer', target: parseChain(parts, index + 1, undefined)};
	return {kind: 'unknown', size: size ?? 0, text: parts.slice(index).join(',')};
}


/** Decodes a type, e.g. "{12}DA3d,STpoint:S".
 * @returns The type and the size of the whole type.
 */
export function parseCdbType(text: string): {type: CType, size: number} {
	const match = /^\{(\d+)\}(.*)$/.exec(text);
	if (!match)
		return {type: {kind: 'unknown', size: 0, text}, size: 0};
	const size = parseInt(match[1]);
	const parts = match[2].split(',');
	return {type: parseChain(parts, 0, size), size};
}


// "<scope>$<name>$<lvl>_<sub>$<block>(<type>)<rest>". Old sdcc versions write "$<lvl>$<block>".
const symbolRegEx = /^(G|F[^$]*|L[^$]*)\$([^$(]+)\$(\d+)(?:_(\d+))?\$(\d+)\(([^)]*)\)(.*)$/;


/** Decodes the part of an "S:" or "F:" record after the "S:"/"F:". */
function parseSymbol(text: string): CdbSymbol | undefined {
	const match = symbolRegEx.exec(text);
	if (!match)
		return undefined;
	const scopeText = match[1];
	const scope = scopeText[0] as 'G' | 'F' | 'L';
	let cModule: string | undefined;
	let func: string | undefined;
	if (scope === 'F') {
		cModule = scopeText.substring(1);
	}
	else if (scope === 'L') {
		const qualified = scopeText.substring(1);
		const dot = qualified.indexOf('.');
		if (dot >= 0) {
			cModule = qualified.substring(0, dot);
			func = qualified.substring(dot + 1);
		}
		else {
			func = qualified;
		}
	}
	const {type, size} = parseCdbType(match[6]);
	// Rest: ",<space>,<onStack>,<offset>[,[<regs>]]" (functions have more fields)
	const rest = match[7];
	const regsMatch = /\[([^\]]*)\]/.exec(rest);
	const fields = rest.replace(/,?\[[^\]]*\]/, '').split(',').filter((_f, i) => i > 0);	// Leading ','
	const registers = regsMatch ? regsMatch[1].split(',').map(r => r.trim()).filter(r => r) : undefined;
	return {
		scope,
		cModule,
		func,
		name: match[2],
		level: parseInt(match[3]),
		subLevel: parseInt(match[4] ?? '0'),
		block: parseInt(match[5]),
		type,
		size,
		addressSpace: fields[0] ?? '',
		onStack: fields[1] === '1',
		stackOffset: parseInt(fields[2] ?? '0') || 0,
		registers
	};
}


/** Decodes the members of a "T:" record: "({0}S:S$x$0_0$0({2}SI:S),Z,0,0)(…)". */
function parseMembers(text: string): CdbMember[] {
	const members: CdbMember[] = [];
	const memberRegEx = /\(\{(\d+)\}S:S\$([^$(]+)\$[^(]*\(([^)]*)\)[^)]*\)/g;
	let match: RegExpExecArray | null;
	while ((match = memberRegEx.exec(text))) {
		const {type, size} = parseCdbType(match[3]);
		members.push({offset: parseInt(match[1]), name: match[2], type, size});
	}
	return members;
}


/** Decodes one record.
 * @param text The decoded record text, e.g. "S:G$player$0_0$0({13}STsprite:S),E,0,0".
 * @returns The record or undefined if unknown or not parsable.
 */
export function parseCdbRecord(text: string): CdbRecord | undefined {
	const kind = text.substring(0, 2);
	const body = text.substring(2);
	switch (kind) {
		case 'M:':
			return {kind: 'module', name: body};
		case 'S:': {
			const symbol = parseSymbol(body);
			return symbol ? {kind: 'symbol', symbol} : undefined;
		}
		case 'F:': {
			const symbol = parseSymbol(body);
			return symbol ? {kind: 'function', symbol} : undefined;
		}
		case 'T:': {
			const match = /^F([^$]*)\$([^[]+)\[(.*)\]$/.exec(body);
			if (!match)
				return undefined;
			return {kind: 'type', struct: {cModule: match[1], tag: match[2], members: parseMembers(match[3])}};
		}
	}
	return undefined;
}
