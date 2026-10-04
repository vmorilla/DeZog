import {CType, CdbMember, CdbSymbol, decodeCdbSymbolName, parseCdbRecord} from './z88dkcdb';
import {Z88dkMapSymbol} from './z88dkmapfile';


/** Where a C variable is stored. */
export type CStorage =
	{kind: 'static', longAddress: number | undefined} |	// undefined: no linker symbol found
	{kind: 'stack', offset: number} |
	{kind: 'register', registers: string[]};


/** A C variable (global, file static, function static, parameter or local). */
export interface CVar {
	/// The C name, e.g. "player".
	cName: string;
	/// The linker symbol for static storage, e.g. "_player" or "_with_static_calls_10000_14".
	linkerName?: string;
	type: CType;
	/// The size of the whole variable in bytes.
	size: number;
	storage: CStorage;
	/// The map module that defines the variable, e.g. "vars_c".
	module: string;
	/// sdcc nesting level (1 = function body) and block.
	level: number;
	block: number;
}


/** A C function. */
export interface CFunction {
	cName: string;
	linkerName: string;
	module: string;
	/// Start address (long address) and end (exclusive).
	start: number;
	end: number;
	/// Parameters and locals on the stack or in registers.
	locals: CVar[];
	/// Function statics by C name.
	statics: Map<string, CVar>;
	/// The C lines of the function with their scope, sorted by address
	/// (from the __C_LINE_ symbols). Empty without "-debug".
	lines: CLineScope[];
}


/** The scope of a C line: its address and sdcc's level (level*10000+sub) and block. */
export interface CLineScope {
	longAddress: number;
	level: number;
	block: number;
}


/** A local visible at a PC. */
export interface CVisibleLocal {
	v: CVar;
	/// True if hidden by a deeper variable of the same name.
	shadowed: boolean;
}


/** A struct or union. */
export interface CStruct {
	tag: string;
	size: number;
	members: CdbMember[];
	isUnion: boolean;
}


/** What the table needs from the map file. */
export interface CMapAccess {
	/// Returns the public map symbol for a name.
	getPublic(name: string): Z88dkMapSymbol | undefined;
	/// Returns the local map symbol of a module.
	getLocal(module: string, name: string): Z88dkMapSymbol | undefined;
	/// All local symbol names of a module.
	getLocalNames(module: string): string[];
	/// All address symbols (code and data), to find the end of a function.
	addressSymbols: Z88dkMapSymbol[];
	/// Converts a z88dk (banked) address into a DeZog long address.
	toLongAddress(value: number): number;
	/// The end (exclusive, long address) of the memory slot of a long address.
	slotEnd(longAddress: number): number;
	/// The C lines (from the __C_LINE_ symbols) with module and scope.
	cLines: Array<CLineScope & {module: string}>;
}


/** The maximum size assumed for a function if no boundary is found. */
const MAX_FUNCTION_SIZE = 0x4000;


/**
 * The C symbol table: the C view of a z88dk program built from the CDB
 * records of the map file ("-debug", sdcc). Kept apart from the assembler
 * labels; see design/c-variables.md.
 */
export class CSymbolTable {
	/// The globals defined in the program's modules, by C name.
	protected globals = new Map<string, CVar>();
	/// The file statics, by map module and C name.
	protected fileStatics = new Map<string, Map<string, CVar>>();
	/// The functions, sorted by start address.
	protected functions: CFunction[] = [];
	/// The structs/unions by map module and tag.
	protected structs = new Map<string, Map<string, CStruct>>();
	/// Linker name -> C name, for the display of C names.
	protected linkerToC = new Map<string, string>();
	/// The linker names of public symbols of C modules ("_x"), for the
	/// fallback lookup without CDB records.
	protected cModuleLinkerNames = new Set<string>();
	/// The map files already loaded (the table is built once per map file).
	protected loadedMapFiles = new Set<string>();


	/** Clears all data. */
	public clear() {
		this.globals.clear();
		this.fileStatics.clear();
		this.functions = [];
		this.structs.clear();
		this.linkerToC.clear();
		this.cModuleLinkerNames.clear();
		this.loadedMapFiles.clear();
	}


	/** True if the table has been built for this map file already. */
	public isLoaded(mapFile: string): boolean {
		return this.loadedMapFiles.has(mapFile);
	}


	/** True if any CDB records were found, i.e. C variables are available. */
	public hasCdb(): boolean {
		return this.functions.length > 0 || this.globals.size > 0;
	}


	/** Builds the table from one map file.
	 * @param mapFile The map file path (to build only once per map file).
	 * @param cdbSymbols The __CDBINFO__ symbols of the map file.
	 * @param mapSymbols All other (non-debug) symbols of the map file.
	 * @param access Map lookups and address conversion.
	 */
	public load(mapFile: string, cdbSymbols: Z88dkMapSymbol[], mapSymbols: Z88dkMapSymbol[], access: CMapAccess) {
		this.loadedMapFiles.add(mapFile);

		// Fallback names: public "_x" symbols of C modules (sdcc and sccz80 name them "<file>_c")
		for (const sym of mapSymbols) {
			if (sym.scope === 'public' && sym.name.startsWith('_') && sym.module.endsWith('_c'))
				this.cModuleLinkerNames.add(sym.name);
		}

		// Decode
		const functionSymbols: Array<{symbol: CdbSymbol, module: string}> = [];
		const varSymbols: Array<{symbol: CdbSymbol, module: string}> = [];
		for (const cdb of cdbSymbols) {
			const text = decodeCdbSymbolName(cdb.name.substring('__CDBINFO__'.length));
			const record = parseCdbRecord(text);
			if (!record)
				continue;
			switch (record.kind) {
				case 'function':
					functionSymbols.push({symbol: record.symbol, module: cdb.module});
					break;
				case 'symbol':
					varSymbols.push({symbol: record.symbol, module: cdb.module});
					break;
				case 'type': {
					const members = record.struct.members;
					const size = members.reduce((max, m) => Math.max(max, m.offset + m.size), 0);
					const isUnion = members.length > 1 && members.every(m => m.offset === 0);
					let map = this.structs.get(cdb.module);
					if (!map) {
						map = new Map();
						this.structs.set(cdb.module, map);
					}
					map.set(record.struct.tag, {tag: record.struct.tag, size, members, isUnion});
					break;
				}
			}
		}

		// Functions (defined in this module: the linker symbol belongs to it)
		const newFunctions: CFunction[] = [];
		for (const {symbol, module} of functionSymbols) {
			// sdcc may write a function's record twice (e.g. a static function
			// with a forward declaration): one function only, or its locals end
			// up on a copy that is never found
			if (newFunctions.some(f => f.cName === symbol.name && f.module === module))
				continue;
			const linkerName = '_' + symbol.name;
			const mapSym = (symbol.scope === 'F') ? access.getLocal(module, linkerName) : access.getPublic(linkerName);
			if (!mapSym || mapSym.module !== module)
				continue;
			newFunctions.push({
				cName: symbol.name,
				linkerName,
				module,
				start: access.toLongAddress(mapSym.value),
				end: 0,	// Set below
				locals: [],
				statics: new Map(),
				lines: []
			});
			this.linkerToC.set(linkerName, symbol.name);
		}
		this.setFunctionEnds(newFunctions, access);
		this.setFunctionLines(newFunctions, access);
		this.functions.push(...newFunctions);
		this.functions.sort((a, b) => a.start - b.start);

		// Variables
		const declaredGlobals: CdbSymbol[] = [];
		for (const {symbol, module} of varSymbols) {
			if (symbol.type.kind === 'function')
				continue;	// Function declaration
			if (symbol.scope === 'G') {
				if (!this.addGlobal(symbol, module, access))
					declaredGlobals.push(symbol);
			}
			else if (symbol.scope === 'F')
				this.addFileStatic(symbol, module, access);
			else
				this.addLocal(symbol, module, access, newFunctions);
		}
		// Globals whose defining module wrote no record: take the type from a
		// declaration if the symbol is defined in a C module (not a library)
		for (const symbol of declaredGlobals) {
			if (this.globals.has(symbol.name))
				continue;
			const linkerName = '_' + symbol.name;
			const mapSym = access.getPublic(linkerName);
			if (!mapSym || !mapSym.module.endsWith('_c'))
				continue;
			this.globals.set(symbol.name, this.createStaticVar(symbol, mapSym.module, linkerName, access.toLongAddress(mapSym.value)));
			this.linkerToC.set(linkerName, symbol.name);
		}
	}


	/** The end of each function: the next function or the next address
	 * symbol of a different module (exclusive), but at most MAX_FUNCTION_SIZE
	 * and not beyond the memory slot. */
	protected setFunctionEnds(functions: CFunction[], access: CMapAccess) {
		const boundaries = access.addressSymbols
			.map(sym => ({addr: access.toLongAddress(sym.value), module: sym.module}));
		for (const f of functions)
			boundaries.push({addr: f.start, module: '\0function'});	// Every function start is a boundary
		boundaries.sort((a, b) => a.addr - b.addr);
		for (const f of functions) {
			let end = Math.min(f.start + MAX_FUNCTION_SIZE, access.slotEnd(f.start));
			for (const b of boundaries) {
				if (b.addr <= f.start)
					continue;
				if (b.addr >= end)
					break;
				if (b.module !== f.module) {
					end = b.addr;
					break;
				}
			}
			f.end = end;
		}
	}


	/** Assigns the C lines (with their scope) to the functions. */
	protected setFunctionLines(functions: CFunction[], access: CMapAccess) {
		for (const line of access.cLines) {
			const func = functions.find(f => f.module === line.module && line.longAddress >= f.start && line.longAddress < f.end);
			if (func)
				func.lines.push({longAddress: line.longAddress, level: line.level, block: line.block});
		}
		for (const f of functions)
			f.lines.sort((a, b) => a.longAddress - b.longAddress);
	}


	/** Adds a global from the record of the module that defines it (header
	 * declarations appear in every including module).
	 * @returns false if the record is a declaration only.
	 */
	protected addGlobal(symbol: CdbSymbol, module: string, access: CMapAccess): boolean {
		const linkerName = '_' + symbol.name;
		const mapSym = access.getPublic(linkerName);
		if (!mapSym || mapSym.module !== module)
			return false;	// Declaration only
		this.globals.set(symbol.name, this.createStaticVar(symbol, module, linkerName, access.toLongAddress(mapSym.value)));
		this.linkerToC.set(linkerName, symbol.name);
		return true;
	}


	/** A file static is the local symbol "_<name>" of its module. */
	protected addFileStatic(symbol: CdbSymbol, module: string, access: CMapAccess) {
		const linkerName = '_' + symbol.name;
		const mapSym = access.getLocal(module, linkerName);
		const longAddress = mapSym ? access.toLongAddress(mapSym.value) : undefined;
		let map = this.fileStatics.get(module);
		if (!map) {
			map = new Map();
			this.fileStatics.set(module, map);
		}
		map.set(symbol.name, this.createStaticVar(symbol, module, linkerName, longAddress));
	}


	/** A local: parameter, stack or register variable, or function static. */
	protected addLocal(symbol: CdbSymbol, module: string, access: CMapAccess, functions: CFunction[]) {
		if (/^sloc\d+$/.test(symbol.name))
			return;	// Compiler temporary
		const func = functions.find(f => f.cName === symbol.func && f.module === module);
		if (!func)
			return;
		if (symbol.addressSpace === 'B') {
			func.locals.push({cName: symbol.name, type: symbol.type, size: symbol.size, storage: {kind: 'stack', offset: symbol.stackOffset}, module, level: symbol.level, block: symbol.block});
		}
		else if (symbol.addressSpace === 'R') {
			func.locals.push({cName: symbol.name, type: symbol.type, size: symbol.size, storage: {kind: 'register', registers: symbol.registers ?? []}, module, level: symbol.level, block: symbol.block});
		}
		else {
			// Function static: "_<func>_<name>_<level*10000+sub>_<block>"
			const linkerName = this.findFunctionStatic(symbol, module, access);
			const mapSym = linkerName ? access.getLocal(module, linkerName) : undefined;
			const longAddress = mapSym ? access.toLongAddress(mapSym.value) : undefined;
			func.statics.set(symbol.name, this.createStaticVar(symbol, module, linkerName, longAddress));
		}
	}


	/** Returns the linker name of a function static. */
	protected findFunctionStatic(symbol: CdbSymbol, module: string, access: CMapAccess): string | undefined {
		const exact = '_' + symbol.func + '_' + symbol.name + '_' + (symbol.level * 10000 + symbol.subLevel) + '_' + symbol.block;
		if (access.getLocal(module, exact))
			return exact;
		const prefix = '_' + symbol.func + '_' + symbol.name + '_';
		const candidates = access.getLocalNames(module).filter(n => n.startsWith(prefix) && /^\d+_\d+$/.test(n.substring(prefix.length)));
		return (candidates.length === 1) ? candidates[0] : undefined;
	}


	protected createStaticVar(symbol: CdbSymbol, module: string, linkerName: string | undefined, longAddress: number | undefined): CVar {
		return {cName: symbol.name, linkerName, type: symbol.type, size: symbol.size, storage: {kind: 'static', longAddress}, module, level: symbol.level, block: symbol.block};
	}


	/** Returns the C function that contains the long address. */
	public functionAt(longAddress: number): CFunction | undefined {
		// Binary search for the last function with start <= address
		let lo = 0;
		let hi = this.functions.length - 1;
		let found: CFunction | undefined;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (this.functions[mid].start <= longAddress) {
				found = this.functions[mid];
				lo = mid + 1;
			}
			else {
				hi = mid - 1;
			}
		}
		if (found && longAddress < found.end)
			return found;
		return undefined;
	}


	/** True if a local is visible at the PC.
	 * Level-1 variables (parameters and the function body's top level) are
	 * visible in the whole function. A deeper variable is visible from a line
	 * of its block up to the next line of a lower level (its block ends
	 * there), which includes the lines of nested blocks.
	 * Without line information only level-1 variables are visible.
	 */
	protected isVisible(v: CVar, func: CFunction, longPc: number): boolean {
		if (v.level <= 1)
			return true;
		const level = v.level * 10000;
		let inSpan = false;
		for (const line of func.lines) {
			if (line.longAddress > longPc)
				break;
			if (line.block === v.block)
				inSpan = true;
			else if (line.level < level)
				inSpan = false;
		}
		return inSpan;
	}


	/** The locals (parameters, stack and register variables) visible at the PC,
	 * parameters first (by stack offset), then by level and name.
	 * A variable hidden by a deeper one of the same name is marked 'shadowed'.
	 * @param func The function containing the PC.
	 * @param longPc The PC (or the call site for outer frames).
	 */
	public visibleLocals(func: CFunction, longPc: number): CVisibleLocal[] {
		const visible = func.locals.filter(v => this.isVisible(v, func, longPc));
		const isParam = (v: CVar) => v.storage.kind === 'stack' && v.storage.offset > 0;
		visible.sort((a, b) => {
			if (isParam(a) !== isParam(b))
				return isParam(a) ? -1 : 1;
			if (isParam(a) && a.storage.kind === 'stack' && b.storage.kind === 'stack')
				return a.storage.offset - b.storage.offset;
			return a.level - b.level || a.cName.localeCompare(b.cName);
		});
		return visible.map(v => ({
			v,
			shadowed: visible.some(o => o !== v && o.cName === v.cName && o.level > v.level)
		}));
	}


	/** The globals, sorted by name. */
	public getGlobals(): CVar[] {
		return [...this.globals.values()].sort((a, b) => a.cName.localeCompare(b.cName));
	}


	/** The statics visible in a function: its function statics, then the
	 * file statics of its module. Sorted by name within each group. */
	public getStatics(func: CFunction): CVar[] {
		const byName = (a: CVar, b: CVar) => a.cName.localeCompare(b.cName);
		const funcStatics = [...func.statics.values()].sort(byName);
		const fileStatics = [...(this.fileStatics.get(func.module)?.values() ?? [])].sort(byName);
		return [...funcStatics, ...fileStatics];
	}


	/** Resolves a C name to a variable with static storage, in C scope order:
	 * the function statics and file statics of the function at the address,
	 * then the globals.
	 * (Locals are resolved by the caller, which knows the frame.)
	 * @param name The C name, e.g. "player". "::name" forces the global.
	 * @param longPc The context (PC) or undefined for globals only.
	 */
	public resolveStatic(name: string, longPc?: number): CVar | undefined {
		if (name.startsWith('::'))
			return this.globals.get(name.substring(2));
		if (longPc !== undefined) {
			const func = this.functionAt(longPc);
			if (func) {
				const v = func.statics.get(name) ?? this.fileStatics.get(func.module)?.get(name);
				if (v)
					return v;
			}
		}
		return this.globals.get(name);
	}


	/** The fallback for builds without CDB records: "name" -> "_name" if
	 * that is a public symbol of a C module.
	 * @returns The linker name or undefined.
	 */
	public fallbackLinkerName(name: string): string | undefined {
		const linkerName = '_' + name;
		return this.cModuleLinkerNames.has(linkerName) ? linkerName : undefined;
	}


	/** Returns the C name for a linker name of a C function or variable,
	 * e.g. "_factorial" -> "factorial", otherwise undefined. */
	public getCName(linkerName: string): string | undefined {
		return this.linkerToC.get(linkerName);
	}


	/** Returns the struct/union for a tag, preferring the given module. */
	public getStruct(tag: string, module?: string): CStruct | undefined {
		if (module) {
			const s = this.structs.get(module)?.get(tag);
			if (s)
				return s;
		}
		for (const map of this.structs.values()) {
			const s = map.get(tag);
			if (s)
				return s;
		}
		return undefined;
	}


	/** The size of a type in bytes (0 if unknown). */
	public sizeOf(type: CType, module?: string): number {
		switch (type.kind) {
			case 'int': return type.size;
			case 'float': return type.size;
			case 'pointer': return 2;
			case 'array': return type.size || type.length * this.sizeOf(type.elem, module);
			case 'struct': return this.getStruct(type.tag, module)?.size ?? 0;
			case 'unknown': return type.size;
			default: return 0;
		}
	}
}
