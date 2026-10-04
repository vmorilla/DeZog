import {DebugProtocol} from '@vscode/debugprotocol';
import {CType} from '../labels/z88dkcdb';
import {CSymbolTable, CVar, CVisibleLocal} from '../labels/csymboltable';
import {CFrameAccess, CFrameAddr, CFrameResolver} from './cframes';
import {Labels} from '../labels/labels';
import {RefList} from '../misc/reflist';
import {Remote} from '../remotes/remotebase';
import {Z80Registers} from '../remotes/z80registers';
import {Settings} from '../settings/settings';
import {ShallowVar} from './shallowvar';


/** The float formats (launch.json "cDebug.floatFormat"). */
export type CFloatFormat = 'math32' | 'math48' | 'raw';


/** How many characters a struct/array preview may have. */
const MAX_PREVIEW = 80;

/** How many bytes of a char array/pointer are shown as string preview. */
const MAX_STRING_PREVIEW = 32;


/** Decodes a z88dk math48 value (6 bytes): bytes 0-4 mantissa (little
 * endian, the top bit of byte 4 is the sign and stands for the implied
 * leading 1), byte 5 the exponent (bias 128, 0 = value 0).
 * Verified with "zcc +zx -lmath48": 1.5 = 00 00 00 00 40 81.
 */
export function decodeMath48(bytes: Uint8Array): number {
	const exponent = bytes[5];
	if (exponent === 0)
		return 0;
	const top = bytes[4];
	const negative = (top & 0x80) !== 0;
	let mantissa = top | 0x80;
	for (let i = 3; i >= 0; i--)
		mantissa = mantissa * 256 + bytes[i];
	const value = mantissa / 2 ** 40 * 2 ** (exponent - 128);
	return negative ? -value : value;
}


/** Decodes a float value.
 * @returns The value or undefined if the format cannot decode this size.
 */
export function decodeFloat(bytes: Uint8Array, format: CFloatFormat): number | undefined {
	if (format === 'math32' && bytes.length === 4)
		return new DataView(bytes.buffer, bytes.byteOffset, 4).getFloat32(0, true);
	if (format === 'math48' && bytes.length === 6)
		return decodeMath48(bytes);
	return undefined;
}


/** Reads an unsigned little endian value (up to 6 bytes are exact). */
function readUnsigned(bytes: Uint8Array, offset: number, size: number): number {
	let value = 0;
	for (let i = size - 1; i >= 0; i--)
		value = value * 256 + bytes[offset + i];
	return value;
}


/** Reads a little endian integer, signed or unsigned, as bigint if > 6 bytes. */
function readInt(bytes: Uint8Array, offset: number, size: number, signed: boolean): number | bigint {
	if (size > 6) {
		let value = 0n;
		for (let i = size - 1; i >= 0; i--)
			value = value * 256n + BigInt(bytes[offset + i]);
		if (signed && (bytes[offset + size - 1] & 0x80))
			value -= 1n << BigInt(8 * size);
		return value;
	}
	let value = readUnsigned(bytes, offset, size);
	if (signed && size > 0 && (bytes[offset + size - 1] & 0x80))
		value -= 2 ** (8 * size);
	return value;
}


/** A printable representation of a char, e.g. 'A' or '\x00'. */
function charLiteral(code: number): string {
	if (code >= 0x20 && code < 0x7F)
		return code === 0x27 ? "'\\''" : "'" + String.fromCharCode(code) + "'";
	switch (code) {
		case 0: return "'\\0'";
		case 0x0A: return "'\\n'";
		case 0x0D: return "'\\r'";
	}
	return "'\\x" + code.toString(16).padStart(2, '0') + "'";
}


/** A string preview of bytes up to the first 0, e.g. "HERO". */
function stringPreview(bytes: Uint8Array, offset: number, max: number): string {
	let text = '';
	for (let i = 0; i < max && offset + i < bytes.length; i++) {
		const c = bytes[offset + i];
		if (c === 0)
			return '"' + text + '"';
		text += (c >= 0x20 && c < 0x7F) ? String.fromCharCode(c) : '\\x' + c.toString(16).padStart(2, '0');
	}
	return '"' + text + '…"';
}


/** True if a char array holds a C string: at least one printable char
 * followed by a 0 inside the array. sdcc's char is unsigned, so "char[]" and
 * "uint8_t[]" have the same type; the contents decide.
 */
function looksLikeString(bytes: Uint8Array, offset: number, length: number): boolean {
	let i = 0;
	while (i < length && offset + i < bytes.length && bytes[offset + i] >= 0x20 && bytes[offset + i] < 0x7F)
		i++;
	return i > 0 && i < length && bytes[offset + i] === 0;
}


/**
 * Formats C values. Knows the types (and struct layouts) of a symbol table.
 */
export class CValueFormatter {
	constructor(protected table: CSymbolTable, protected floatFormat: CFloatFormat) {}


	/** The C name of a type, e.g. "unsigned char", "struct sprite", "int*", "char[6]". */
	public typeName(type: CType, module?: string): string {
		switch (type.kind) {
			case 'int': {
				if (type.isBool)
					return 'bool';
				let name: string;
				if (type.isChar)
					name = 'char';
				else if (type.size === 2)
					name = 'int';
				else if (type.size === 4)
					name = 'long';
				else if (type.size === 8)
					name = 'long long';
				else
					name = 'int' + (8 * type.size);
				return (type.signed ? '' : 'unsigned ') + name;
			}
			case 'float': return 'float';
			case 'void': return 'void';
			case 'pointer': return this.typeName(type.target, module) + '*';
			case 'array': return this.typeName(type.elem, module) + '[' + type.length + ']';
			case 'function': return this.typeName(type.ret, module) + '()';
			case 'struct': return (this.table.getStruct(type.tag, module)?.isUnion ? 'union ' : 'struct ') + type.tag;
			case 'bitfield': return (type.signed ? 'int' : 'unsigned') + ':' + type.bitWidth;
			case 'unknown': return '?' + type.text;
		}
	}


	/** True if the type has children in the VARIABLES pane. */
	public isExpandable(type: CType): boolean {
		if (type.kind === 'struct' || type.kind === 'array')
			return true;
		if (type.kind === 'pointer')
			return type.target.kind !== 'void' && type.target.kind !== 'function';
		return false;
	}


	/** Formats a value.
	 * @param type The type.
	 * @param bytes The memory, at least the size of the type from offset.
	 * @param offset The offset of the value in bytes.
	 * @param module The module (for struct lookups).
	 * @param depth Nesting depth for previews.
	 */
	public format(type: CType, bytes: Uint8Array, offset: number, module?: string, depth = 0): string {
		const size = this.table.sizeOf(type, module);
		if (type.kind !== 'bitfield' && offset + size > bytes.length)
			return '<not readable>';
		switch (type.kind) {
			case 'int': {
				const value = readInt(bytes, offset, type.size, type.signed);
				if (type.isBool)
					return (value === 0) ? 'false' : (value === 1) ? 'true' : value.toString();
				// The char only if printable: sdcc's uint8_t is a char, too
				const code = bytes[offset];
				if (type.isChar && code >= 0x20 && code < 0x7F)
					return value.toString() + ' ' + charLiteral(code);
				return value.toString();
			}
			case 'float': {
				const raw = bytes.subarray(offset, offset + type.size);
				const value = decodeFloat(raw, this.floatFormat);
				return (value === undefined) ? this.rawBytes(raw) : value.toString();
			}
			case 'pointer': {
				const addr = readUnsigned(bytes, offset, 2);
				return (addr === 0) ? 'NULL' : '0x' + addr.toString(16).toUpperCase().padStart(4, '0');
			}
			case 'array': {
				if (type.elem.kind === 'int' && type.elem.isChar && looksLikeString(bytes, offset, type.length))
					return stringPreview(bytes, offset, Math.min(type.length, MAX_STRING_PREVIEW));
				if (depth > 0)
					return '[…]';
				const elemSize = this.table.sizeOf(type.elem, module);
				const parts: string[] = [];
				for (let i = 0; i < type.length; i++) {
					parts.push(this.format(type.elem, bytes, offset + i * elemSize, module, depth + 1));
					if (parts.join(', ').length > MAX_PREVIEW) {
						parts.push('…');
						break;
					}
				}
				return '[' + parts.join(', ') + ']';
			}
			case 'struct': {
				const struct = this.table.getStruct(type.tag, module);
				if (!struct)
					return this.rawBytes(bytes.subarray(offset, offset + size));
				if (depth > 1)
					return '{…}';
				const parts: string[] = [];
				for (const m of struct.members) {
					parts.push(m.name + '=' + this.format(m.type, bytes, offset + m.offset, module, depth + 1));
					if (parts.join(', ').length > MAX_PREVIEW) {
						parts.push('…');
						break;
					}
				}
				return '{' + parts.join(', ') + '}';
			}
			case 'bitfield': {
				const byteCount = Math.ceil((type.bitOffset + type.bitWidth) / 8);
				if (offset + byteCount > bytes.length)
					return '<not readable>';
				const word = readUnsigned(bytes, offset, byteCount);
				let value = Math.floor(word / 2 ** type.bitOffset) % 2 ** type.bitWidth;
				if (type.signed && value >= 2 ** (type.bitWidth - 1))
					value -= 2 ** type.bitWidth;
				return value.toString();
			}
			case 'function':
				return '0x' + readUnsigned(bytes, offset, 2).toString(16).toUpperCase().padStart(4, '0');
			case 'void':
				return 'void';
			case 'unknown':
				return this.rawBytes(bytes.subarray(offset, offset + size));
		}
	}


	/** Raw bytes, e.g. "[00 00 C0 3F]". */
	public rawBytes(bytes: Uint8Array): string {
		return '[' + [...bytes].map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ') + ']';
	}


	/** Encodes a number for a scalar type (for setting a value).
	 * @returns The bytes or undefined if the type cannot be set.
	 */
	public encode(type: CType, value: number): Uint8Array | undefined {
		if (type.kind === 'int' && type.size <= 6) {
			const bytes = new Uint8Array(type.size);
			let v = Math.trunc(value);
			if (v < 0)
				v += 2 ** (8 * type.size);
			for (let i = 0; i < type.size; i++) {
				bytes[i] = v % 256;
				v = Math.floor(v / 256);
			}
			return bytes;
		}
		if (type.kind === 'pointer')
			return new Uint8Array([value & 0xFF, (value >>> 8) & 0xFF]);
		if (type.kind === 'float' && this.floatFormat === 'math32' && type.size === 4) {
			const bytes = new Uint8Array(4);
			new DataView(bytes.buffer).setFloat32(0, value, true);
			return bytes;
		}
		return undefined;
	}
}


/** Returns the formatter for the current settings. */
function formatter(): CValueFormatter {
	return new CValueFormatter(Labels.cSymbols, Settings.launch?.cDebug?.floatFormat ?? 'math32');
}


/** The 64k address of a static variable, or a reason why it cannot be read. */
function staticAddress(v: CVar): {addr64k: number} | {error: string} {
	if (v.storage.kind !== 'static' || v.storage.longAddress === undefined)
		return {error: '<no address>'};
	const longAddress = v.storage.longAddress;
	const addr64k = longAddress & 0xFFFF;
	// Banked: is the bank paged in?
	if (longAddress > 0xFFFF && Z80Registers.createLongAddress(addr64k) !== longAddress)
		return {error: '<bank ' + ((longAddress >>> 16) - 1) + ' not paged in>'};
	return {addr64k};
}


/**
 * Common part of the C variable containers: creates the DAP variables and
 * the child objects for expandable values (reused across stops, so the
 * variables list does not grow at every step).
 */
abstract class CVarContainer extends ShallowVar {
	/// Children by key "address:type", to reuse their references.
	protected childRefs = new Map<string, number>();

	constructor(protected list: RefList<ShallowVar>) {
		super();
	}


	/** Creates the DAP variable for a value at a 64k address. */
	protected createVariable(fmt: CValueFormatter, name: string, type: CType, module: string, bytes: Uint8Array, offset: number, addr64k: number): DebugProtocol.Variable {
		const value = fmt.format(type, bytes, offset, module);
		let variablesReference = 0;
		let indexedVariables: number | undefined;
		if (fmt.isExpandable(type)) {
			let childAddr = addr64k;
			if (type.kind === 'pointer')
				childAddr = (bytes[offset] | (bytes[offset + 1] << 8));
			if (type.kind !== 'pointer' || childAddr !== 0) {
				const key = childAddr + ':' + JSON.stringify(type) + ':' + module;
				let ref = this.childRefs.get(key);
				if (ref === undefined) {
					ref = this.list.addObject(new CValueVar(childAddr, type, module, this.list));
					this.childRefs.set(key, ref);
				}
				variablesReference = ref;
				if (type.kind === 'array')
					indexedVariables = type.length;
			}
		}
		return {
			name,
			type: fmt.typeName(type, module),
			value,
			variablesReference,
			indexedVariables,
			memoryReference: '0x' + addr64k.toString(16).toUpperCase().padStart(4, '0')
		};
	}
}


/**
 * The children of an expandable C value: the members of a struct/union, the
 * elements of an array, or the target of a pointer ("*p").
 */
export class CValueVar extends CVarContainer {
	constructor(protected addr64k: number, protected type: CType, protected module: string, list: RefList<ShallowVar>) {
		super(list);
	}


	/** The children: name, type and offset (relative to addr64k). */
	protected children(start: number, count: number): Array<{name: string, type: CType, offset: number}> {
		const table = Labels.cSymbols;
		const type = this.type;
		switch (type.kind) {
			case 'struct': {
				const struct = table.getStruct(type.tag, this.module);
				return struct ? struct.members.map(m => ({name: m.name, type: m.type, offset: m.offset})) : [];
			}
			case 'array': {
				const elemSize = table.sizeOf(type.elem, this.module);
				const first = start ?? 0;
				const n = Math.min(count || type.length, type.length - first);
				const result: Array<{name: string, type: CType, offset: number}> = [];
				for (let i = first; i < first + n; i++)
					result.push({name: '[' + i + ']', type: type.elem, offset: i * elemSize});
				return result;
			}
			case 'pointer':
				return [{name: '*', type: type.target, offset: 0}];
		}
		return [];
	}


	public async getContent(start: number, count: number): Promise<Array<DebugProtocol.Variable>> {
		const fmt = formatter();
		const children = this.children(start, count);
		if (children.length === 0)
			return [];
		const base = children[0].offset;
		const last = children[children.length - 1];
		let size = last.offset + Labels.cSymbols.sizeOf(last.type, this.module) - base;
		// A char pointer/array element: read a bit more for the string preview
		size = Math.max(size, 1);
		if (this.type.kind === 'pointer' && this.type.target.kind === 'int' && this.type.target.isChar)
			size = Math.max(size, MAX_STRING_PREVIEW);
		const addr = (this.addr64k + base) & 0xFFFF;
		const bytes = await Remote.readMemoryDump(addr, Math.min(size, 0x10000 - addr));
		return children.map(c => {
			if (this.type.kind === 'pointer' && c.type.kind === 'int' && c.type.isChar) {
				// "*p" of a char pointer: the char and the string
				const variable = this.createVariable(fmt, c.name, c.type, this.module, bytes, c.offset - base, addr + c.offset - base);
				variable.value += '  ' + stringPreview(bytes, 0, MAX_STRING_PREVIEW);
				return variable;
			}
			return this.createVariable(fmt, c.name, c.type, this.module, bytes, c.offset - base, (addr + c.offset - base) & 0xFFFF);
		});
	}


	public async setValue(name: string, value: number): Promise<string> {
		const child = this.children(0, 0).find(c => c.name === name);
		if (!child)
			return undefined as any;
		return writeValue(child.type, this.module, (this.addr64k + child.offset) & 0xFFFF, value);
	}
}


/** Writes a scalar value and returns the formatted value read back. */
async function writeValue(type: CType, module: string, addr64k: number, value: number): Promise<string> {
	const fmt = formatter();
	const bytes = fmt.encode(type, value);
	if (!bytes)
		throw Error("Values of type '" + fmt.typeName(type, module) + "' cannot be set.");
	await Remote.writeMemoryDump(addr64k, bytes);
	ShallowVar.memoryChanged = true;
	const readBack = await Remote.readMemoryDump(addr64k, bytes.length);
	return fmt.format(type, readBack, 0, module);
}


/**
 * A scope of C variables with static storage: "C Globals" or "C Statics".
 * The memory of all variables is read with one request.
 */
export class CStaticVarsScope extends CVarContainer {
	/// The variables shown, set when a frame is selected.
	protected vars: CVar[] = [];


	/** Sets the variables to show. */
	public setVars(vars: CVar[]) {
		this.vars = vars;
	}


	/** True if there is something to show. */
	public isEmpty(): boolean {
		return this.vars.length === 0;
	}


	public async getContent(_start: number, _count: number): Promise<Array<DebugProtocol.Variable>> {
		const fmt = formatter();
		const table = Labels.cSymbols;
		const located = this.vars.map(v => ({v, loc: staticAddress(v), size: Math.max(table.sizeOf(v.type, v.module), 1)}));
		const readable = located.filter(l => 'addr64k' in l.loc);
		const blocks = readable.map(l => ({addr64k: (l.loc as {addr64k: number}).addr64k, size: Math.min(l.size, 0x10000 - (l.loc as {addr64k: number}).addr64k)}));
		const data = (blocks.length > 0) ? await Remote.readMemoryBlocks(blocks) : [];
		const memory = new Map<CVar, Uint8Array>();
		readable.forEach((l, i) => memory.set(l.v, data[i]));
		return located.map(({v, loc}) => {
			if ('error' in loc)
				return {name: v.cName, type: fmt.typeName(v.type, v.module), value: loc.error, variablesReference: 0};
			return this.createVariable(fmt, v.cName, v.type, v.module, memory.get(v)!, 0, loc.addr64k);
		});
	}


	public async setValue(name: string, value: number): Promise<string> {
		const v = this.vars.find(x => x.cName === name);
		if (!v)
			return undefined as any;
		const loc = staticAddress(v);
		if ('error' in loc)
			throw Error(name + ': ' + loc.error);
		return writeValue(v.type, v.module, loc.addr64k, value);
	}
}


/** Where the value of a C variable comes from. */
export type CValueSource =
	{addr64k: number} |	// Memory
	{registers: string[]} |	// Registers (top frame only), least significant first
	{bytes: Uint8Array} |	// A computed value without address (e.g. "n + 1", "&player")
	{error: string};	// Not available, e.g. "<frame not found>"


/** The 64k address of a stack variable in a frame, or why it is not available. */
export function stackSource(v: CVar, base: {base: number} | {error: string} | undefined): CValueSource {
	if (v.storage.kind !== 'stack')
		return {error: '<not on the stack>'};
	if (!base)
		return {error: '<frame not found>'};
	if ('error' in base)
		return base;
	return {addr64k: (base.base + v.storage.offset) & 0xFFFF};
}


/** The register pair name of a register variable, e.g. ['e','d'] -> "DE". */
export function registerName(registers: string[]): string {
	return [...registers].reverse().join('').toUpperCase();
}


/** The bytes of a register variable (least significant first). */
function registerBytes(registers: string[]): Uint8Array {
	return new Uint8Array(registers.map(r => Remote.getRegisterValue(r) & 0xFF));
}


/** The result of evaluating a single C variable. */
export interface CEvaluation {
	value: string;
	type: string;
	varRef: number;
	count?: number;
	address?: number;
	size: number;
}


/**
 * The value of a single C variable, for the WATCH pane and hovering.
 * Returns the formatted value and, for expandable types, a variable
 * reference for the children.
 * @param v The variable.
 * @param source Where the value is (memory, registers or an error).
 * @param list The variables list the children are added to.
 * @param refCache Reuses the children's references across evaluations
 * (key "address:type:module"). Must be cleared together with the list.
 */
export async function evaluateCVar(v: CVar, source: CValueSource, list: RefList<ShallowVar>, refCache: Map<string, number>): Promise<CEvaluation> {
	return evaluateCPlace(v.type, v.module, source, list, refCache);
}


/**
 * The value of a C value of the given type (WATCH, hover): a variable or the
 * result of a C expression. See evaluateCVar.
 * @param type The type.
 * @param module The module (for struct lookups).
 * @param source Where the value is.
 */
export async function evaluateCPlace(type: CType, module: string, source: CValueSource, list: RefList<ShallowVar>, refCache: Map<string, number>): Promise<CEvaluation> {
	const fmt = formatter();
	const table = Labels.cSymbols;
	const size = Math.max(table.sizeOf(type, module), 1);
	const typeName = fmt.typeName(type, module);
	if ('error' in source)
		return {value: source.error, type: typeName, varRef: 0, size};
	if ('registers' in source) {
		const bytes = registerBytes(source.registers);
		return {value: fmt.format(type, bytes, 0, module) + '  (in ' + registerName(source.registers) + ', may be stale)', type: typeName, varRef: 0, size};
	}
	const addr64k = ('addr64k' in source) ? source.addr64k : undefined;
	const bytes = ('bytes' in source) ? source.bytes : await Remote.readMemoryDump(addr64k!, Math.min(size, 0x10000 - addr64k!));
	let varRef = 0;
	// A computed value has no memory: only a pointer can be expanded (to its target)
	if (fmt.isExpandable(type) && (addr64k !== undefined || type.kind === 'pointer')) {
		let childAddr = addr64k ?? 0;
		if (type.kind === 'pointer')
			childAddr = bytes[0] | (bytes[1] << 8);
		if (type.kind !== 'pointer' || childAddr !== 0) {
			const key = childAddr + ':' + JSON.stringify(type) + ':' + module;
			varRef = refCache.get(key) ?? list.addObject(new CValueVar(childAddr, type, module, list));
			refCache.set(key, varRef);
		}
	}
	return {
		value: fmt.format(type, bytes, 0, module),
		type: typeName,
		varRef,
		count: (type.kind === 'array') ? type.length : undefined,
		address: addr64k,
		size
	};
}


/** Writes a scalar value to a place given by a C expression (WATCH).
 * @returns The formatted value read back.
 * @throws If the place cannot be written (register, computed value, struct).
 */
export async function writeCPlace(type: CType, module: string, source: CValueSource, value: number): Promise<string> {
	if ('registers' in source)
		throw Error("The value is held in a register and cannot be set.");
	if ('error' in source)
		throw Error(source.error);
	if (!('addr64k' in source))
		throw Error("Not a variable: the result of an expression cannot be set.");
	return writeValue(type, module, source.addr64k, value);
}


/** Where the value of a C variable with static storage is (memory or the reason why not). */
export function staticSource(v: CVar): CValueSource {
	const loc = staticAddress(v);
	return ('error' in loc) ? loc : {addr64k: loc.addr64k};
}


/** The value of a C variable with static storage (WATCH, hover). See evaluateCVar. */
export async function evaluateCStatic(v: CVar, list: RefList<ShallowVar>, refCache: Map<string, number>): Promise<CEvaluation> {
	const loc = staticAddress(v);
	return evaluateCVar(v, ('error' in loc) ? loc : {addr64k: loc.addr64k}, list, refCache);
}


/**
 * The "C Locals" scope: the parameters and locals visible in the selected
 * frame. Stack variables are read with one request relative to the frame
 * base; register variables are shown for the top frame only.
 */
export class CLocalsScope extends CVarContainer {
	protected frames: CFrameAddr[] = [];
	protected frameIndex = 0;
	protected locals: CVisibleLocal[] = [];
	protected resolver: CFrameResolver;
	protected access: CFrameAccess;


	/** Sets the frame to show.
	 * @param frames The call stack, bottom (0) to top.
	 * @param frameIndex The selected frame.
	 * @param locals The locals visible in that frame.
	 */
	public setFrame(frames: CFrameAddr[], frameIndex: number, locals: CVisibleLocal[], resolver: CFrameResolver, access: CFrameAccess) {
		this.frames = frames;
		this.frameIndex = frameIndex;
		this.locals = locals;
		this.resolver = resolver;
		this.access = access;
	}


	/** True if there is something to show. */
	public isEmpty(): boolean {
		return this.locals.length === 0;
	}


	/** The name shown for a local: a shadowed one gets " (outer)". */
	protected displayName(local: CVisibleLocal): string {
		return local.shadowed ? local.v.cName + ' (outer)' : local.v.cName;
	}


	/** Where each local's value is. */
	protected async getSources(): Promise<CValueSource[]> {
		const needsBase = this.locals.some(l => l.v.storage.kind === 'stack');
		const base = needsBase ? (await this.resolver.getFrameBases(this.frames, this.access))[this.frameIndex] : undefined;
		const isTop = (this.frameIndex === this.frames.length - 1);
		return this.locals.map(({v}) => {
			if (v.storage.kind === 'register')
				return isTop ? {registers: v.storage.registers} : {error: '<in register, unavailable>'};
			return stackSource(v, base);
		});
	}


	public async getContent(_start: number, _count: number): Promise<Array<DebugProtocol.Variable>> {
		const fmt = formatter();
		const table = Labels.cSymbols;
		const sources = await this.getSources();
		// Read all stack variables at once
		const blocks: Array<{addr64k: number, size: number}> = [];
		const blockIndex: number[] = [];
		sources.forEach((src, i) => {
			if ('addr64k' in src) {
				blockIndex[i] = blocks.length;
				const size = Math.max(table.sizeOf(this.locals[i].v.type, this.locals[i].v.module), 1);
				blocks.push({addr64k: src.addr64k, size: Math.min(size, 0x10000 - src.addr64k)});
			}
		});
		const data = (blocks.length > 0) ? await Remote.readMemoryBlocks(blocks) : [];
		return this.locals.map((local, i) => {
			const v = local.v;
			const name = this.displayName(local);
			const src = sources[i];
			if ('addr64k' in src)
				return this.createVariable(fmt, name, v.type, v.module, data[blockIndex[i]], 0, src.addr64k);
			if ('registers' in src)
				return {name, type: fmt.typeName(v.type, v.module), value: fmt.format(v.type, registerBytes(src.registers), 0, v.module) + '  (in ' + registerName(src.registers) + ', may be stale)', variablesReference: 0};
			if ('bytes' in src)
				return {name, type: fmt.typeName(v.type, v.module), value: fmt.format(v.type, src.bytes, 0, v.module), variablesReference: 0};
			return {name, type: fmt.typeName(v.type, v.module), value: src.error, variablesReference: 0};
		});
	}


	public async setValue(name: string, value: number): Promise<string> {
		const index = this.locals.findIndex(l => this.displayName(l) === name);
		if (index < 0)
			return undefined as any;
		const v = this.locals[index].v;
		const src = (await this.getSources())[index];
		try {
			return await writeCPlace(v.type, v.module, src, value);
		}
		catch (e) {
			throw Error(name + ': ' + e.message);
		}
	}
}
