import {CFunction, CSymbolTable, CVisibleLocal} from '../labels/csymboltable';
import {Labels} from '../labels/labels';
import {Remote} from '../remotes/remotebase';
import {Z80Registers} from '../remotes/z80registers';
import {Settings} from '../settings/settings';
import {CFrameAccess, CFrameAddr, CFrameResolver} from './cframes';
import {CExprContext, CExprNode, CExprUnknownName, CPlace, cPlaceToNumber, evaluateCExpression, namesInCExpression, parseCExpression} from './cexpr';
import {CValueSource, formatCPlace, stackSource, staticSource} from './cvars';


/**
 * The C expressions of a debug session, shared by WATCH, hovering, logpoints
 * and breakpoint conditions (design/c-variables.md, section 12.A).
 */
export class CExpressionService {
	/// The frame bases (prologues are cached per session).
	protected resolver: CFrameResolver;


	/** Resets the service for a new debug session. */
	public reset(table: CSymbolTable, framePointer: 'auto' | 'ix' | 'iy') {
		this.resolver = new CFrameResolver(table, framePointer);
	}


	/** The frame resolver (e.g. for the "C Locals" scope). */
	public get frameResolver(): CFrameResolver {
		this.resolver ??= new CFrameResolver(Labels.cSymbols, 'auto');
		return this.resolver;
	}


	/** True if C expressions are available: C debugging enabled and C debug information. */
	public isAvailable(): boolean {
		return (Settings.launch?.cDebug?.enabled ?? true) && Labels.cSymbols.hasCdb();
	}


	/** Parses an expression with the rule shared by all users: valid C syntax,
	 * at least one name, and no linker names ("_player"). Whether the names are
	 * C variables is only known in a context (see resolve).
	 * @returns The syntax tree, or undefined if not a C expression (e.g.
	 * "label,2,10", "0x8000", "_player").
	 */
	public parse(text: string): CExprNode | undefined {
		if (!this.isAvailable())
			return undefined;
		const trimmed = text.trim();
		if (/[,;]/.test(trimmed))
			return undefined;	// Label expression syntax
		let tree: CExprNode;
		try {
			tree = parseCExpression(trimmed);
		}
		catch {
			return undefined;	// Not C
		}
		const names = namesInCExpression(tree);
		if (names.length === 0 || names.some(n => n.startsWith('_')))
			return undefined;	// No C variable, or a linker name
		return tree;
	}


	/** True if all names of the expression are C variables somewhere in the
	 * program (for a decision without context, e.g. a logpoint when it is
	 * created: its locals are only known when it is hit). */
	public usesOnlyCNames(tree: CExprNode): boolean {
		return namesInCExpression(tree).every(n => Labels.cSymbols.isKnownCName(n.replace(/^::/, '')));
	}


	/** The remote access for the frame resolver. */
	public access(): CFrameAccess {
		return {
			read: (addr64k, size) => Remote.readMemoryDump(addr64k, size),
			getRegister: (name) => Remote.getRegisterValue(name),
			isPagedIn: (longAddress) => Z80Registers.createLongAddress(longAddress & 0xFFFF) === longAddress
		};
	}


	/** The locals visible in a frame (register variables hidden if so configured). */
	public visibleLocals(frames: CFrameAddr[], frameIndex: number): CVisibleLocal[] {
		const frame = frames[frameIndex];
		const func: CFunction | undefined = frame ? Labels.cSymbols.functionAt(frame.addr) : undefined;
		if (!func)
			return [];
		const locals = Labels.cSymbols.visibleLocals(func, frame.addr);
		if (Settings.launch?.cDebug?.registerVariables === 'hide')
			return locals.filter(l => l.v.storage.kind !== 'register');
		return locals;
	}


	/** The evaluation context of a frame: names are resolved in C scope order,
	 * the locals visible in the frame, then the statics and globals ("::name"
	 * forces the global). */
	protected context(frames: CFrameAddr[], frameIndex: number): CExprContext {
		const contextPc = frames[frameIndex]?.addr ?? Remote.getPCLong();
		let bases: Awaited<ReturnType<CFrameResolver['getFrameBases']>> | undefined;
		return {
			resolve: async (name: string) => {
				const plain = name.replace(/^::/, '');
				if (!name.startsWith('::')) {
					// Locals (the visible, not shadowed one of that name)
					const local = this.visibleLocals(frames, frameIndex).find(l => !l.shadowed && l.v.cName === plain);
					if (local) {
						const v = local.v;
						if (v.storage.kind === 'register') {
							if (frameIndex !== frames.length - 1)
								throw Error(plain + ': <in register, unavailable>');
							return {kind: 'register', registers: v.storage.registers, type: v.type, module: v.module};
						}
						bases ??= await this.frameResolver.getFrameBases(frames, this.access());
						const src = stackSource(v, bases[frameIndex]);
						if ('error' in src)
							throw Error(plain + ': ' + src.error);
						return {kind: 'memory', addr64k: (src as {addr64k: number}).addr64k, type: v.type, module: v.module};
					}
				}
				// Statics and globals
				const v = Labels.cSymbols.resolveStatic(name, contextPc);
				if (!v)
					return undefined;
				const src = staticSource(v);
				if ('error' in src)
					throw Error(plain + ': ' + src.error);
				return {kind: 'memory', addr64k: (src as {addr64k: number}).addr64k, type: v.type, module: v.module};
			},
			read: (addr64k: number, size: number) => Remote.readMemoryDump(addr64k, size),
			getRegister: (name: string) => Remote.getRegisterValue(name),
			table: Labels.cSymbols
		};
	}


	/** Resolves a C expression in the context of a frame.
	 * @param expression The expression (text or parsed).
	 * @param frames The call stack, bottom (0) to top.
	 * @param frameIndex The frame.
	 * @returns The place, an error, or undefined if not a C expression (see
	 * parse) or a name is not a C variable here: then it is a label expression.
	 */
	public async resolve(expression: string | CExprNode, frames: CFrameAddr[], frameIndex: number): Promise<{place: CPlace, ctx: CExprContext} | {error: string} | undefined> {
		const tree = (typeof expression === 'string') ? this.parse(expression) : expression;
		if (!tree)
			return undefined;
		const ctx = this.context(frames, frameIndex);
		try {
			return {place: await evaluateCExpression(tree, ctx), ctx};
		}
		catch (e) {
			if (e instanceof CExprUnknownName)
				return undefined;	// E.g. a label or register name
			return {error: e.message};
		}
	}


	/** Resolves a C expression at the current PC (the top frame), e.g. for a
	 * logpoint or a breakpoint condition: they are evaluated at their address. */
	public async resolveAtPc(expression: string | CExprNode): Promise<{place: CPlace, ctx: CExprContext} | {error: string} | undefined> {
		return this.resolve(expression, [{addr: Remote.getPCLong()}], 0);
	}


	/** Where the result of a C expression is. */
	public source(place: CPlace): CValueSource {
		switch (place.kind) {
			case 'memory': return {addr64k: place.addr64k};
			case 'register': return {registers: place.registers};
			case 'value': return {bytes: place.bytes};
		}
	}


	/** The text of a result, formatted by its C type as in WATCH. */
	public async toText(place: CPlace): Promise<string> {
		return formatCPlace(place.type, place.module, this.source(place));
	}


	/** The number of a scalar result (int, char, bool, pointer, bitfield).
	 * @throws For other types.
	 */
	public async toNumber(place: CPlace, ctx: CExprContext): Promise<number> {
		return cPlaceToNumber(place, ctx);
	}
}


/** The service of the debug session. */
export const CExpressions = new CExpressionService();
