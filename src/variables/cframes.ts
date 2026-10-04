import {CFunction, CSymbolTable} from '../labels/csymboltable';


/**
 * The frame base of C functions (sdcc), see design/c-variables.md, section 4.
 *
 * sdcc addresses parameters (positive offsets) and stack locals (negative
 * offsets) relative to a frame pointer, normally IX (IY with
 * "-clib=sdcc_ix", where z88dk swaps IX and IY when assembling). The
 * prologue is "call ___sdcc_enter_ix" or "push ix / ld ix,0 / add ix,sp",
 * the epilogue "pop ix / ret". After the prologue the frame base is the
 * frame pointer; at the function's first instruction and at the final 'ret'
 * it is SP-2 (the return address is at SP). The saved frame pointer of the
 * caller is at (base+0), so the outer frames are found by following that
 * chain: each frame of a function that sets up a frame consumes one link.
 */


/** What the resolver needs from the remote. */
export interface CFrameAccess {
	/// Reads memory (64k address).
	read(addr64k: number, size: number): Promise<Uint8Array>;
	/// Returns a register value, e.g. 'SP', 'IX', 'IY'.
	getRegister(name: string): number;
	/// True if the long address is currently paged in (its code can be read).
	isPagedIn(longAddress: number): boolean;
}


/** How a function sets up its frame. */
export interface CPrologue {
	/// True if the function sets up a frame (pushes the frame pointer).
	usesFrame: boolean;
	/// The frame pointer register.
	register: 'ix' | 'iy';
	/// 'call' (call ___sdcc_enter_ix), 'inline' (push/ld/add) or 'unknown' (code not readable).
	kind: 'call' | 'inline' | 'unknown';
}


/** The frame base of one frame, or why it is not available. */
export type CFrameBase = {base: number} | {error: string};


/** Minimal frame information (CallStackFrame satisfies it). */
export interface CFrameAddr {
	/// The long address in the frame: the PC (top frame) or the call site.
	addr: number;
}


const PUSH_IX = [0xDD, 0xE5];
const PUSH_IY = [0xFD, 0xE5];


/** Returns the frame pointer pushed by the code, or undefined. */
function pushedRegister(bytes: Uint8Array, from: number, to: number): 'ix' | 'iy' | undefined {
	for (let i = from; i < to - 1 && i < bytes.length - 1; i++) {
		if (bytes[i] === PUSH_IX[0] && bytes[i + 1] === PUSH_IX[1])
			return 'ix';
		if (bytes[i] === PUSH_IY[0] && bytes[i + 1] === PUSH_IY[1])
			return 'iy';
	}
	return undefined;
}


/**
 * Finds the frame bases of the C frames of a call stack.
 */
export class CFrameResolver {
	/// The prologue of each function (by start address). Code does not change while debugging.
	protected prologues = new Map<number, CPrologue>();

	/**
	 * @param table The C symbol table.
	 * @param framePointer launch.json "cDebug.framePointer".
	 */
	constructor(protected table: CSymbolTable, protected framePointer: 'auto' | 'ix' | 'iy') {}


	/** Clears the cached prologues (e.g. after a program reload). */
	public clear() {
		this.prologues.clear();
	}


	/** Returns how the function sets up its frame. */
	public async getPrologue(func: CFunction, access: CFrameAccess): Promise<CPrologue> {
		let prologue = this.prologues.get(func.start);
		if (prologue)
			return prologue;
		const hasStackVars = func.locals.some(v => v.storage.kind === 'stack');
		const fixed = (this.framePointer === 'auto') ? undefined : this.framePointer;
		if (!access.isPagedIn(func.start)) {
			// Code not readable: sdcc sets up a frame for functions with stack variables. Not cached.
			return {usesFrame: hasStackVars, register: fixed ?? 'ix', kind: 'unknown'};
		}
		const bytes = await access.read(func.start & 0xFFFF, 8);
		const inline = pushedRegister(bytes, 0, 2);
		if (inline && bytes[2] === bytes[0] && bytes[3] === 0x21 && bytes[4] === 0 && bytes[5] === 0 && bytes[6] === bytes[0] && bytes[7] === 0x39) {
			// push ix / ld ix,0 / add ix,sp
			prologue = {usesFrame: true, register: fixed ?? inline, kind: 'inline'};
		}
		else if (bytes[0] === 0xCD) {
			// call nn: the frame helper ("pop hl / push ix / ld ix,0 / add ix,sp / jp (hl)")?
			const target = bytes[1] | (bytes[2] << 8);
			const helper = await access.read(target, 8);
			const register = pushedRegister(helper, 0, 8);
			prologue = register ? {usesFrame: true, register: fixed ?? register, kind: 'call'} : {usesFrame: false, register: fixed ?? 'ix', kind: 'call'};
		}
		else {
			prologue = {usesFrame: false, register: fixed ?? 'ix', kind: 'inline'};
		}
		this.prologues.set(func.start, prologue);
		return prologue;
	}


	/** Returns the frame base of the top frame if the frame pointer does not
	 * (yet or anymore) belong to it, i.e. in the prologue or at the final 'ret'.
	 * @returns The base or undefined if the frame pointer is the base.
	 */
	protected async topFrameBaseFromSp(func: CFunction, prologue: CPrologue, pc: number, access: CFrameAccess): Promise<number | undefined> {
		const sp = access.getRegister('SP');
		const offset = pc - func.start;
		if (offset === 0)
			return (sp - 2) & 0xFFFF;	// Nothing executed yet
		if (prologue.kind === 'inline' && (offset === 2 || offset === 6))
			return sp;	// After "push ix" (and "ld ix,0"): SP points to the saved frame pointer
		// At the final 'ret' after "pop ix"?
		const pc64k = pc & 0xFFFF;
		if (pc64k >= 2) {
			const bytes = await access.read(pc64k - 2, 3);
			const popReg = (prologue.register === 'ix') ? 0xDD : 0xFD;
			if (bytes[2] === 0xC9 && bytes[0] === popReg && bytes[1] === 0xE1)
				return (sp - 2) & 0xFFFF;
		}
		return undefined;
	}


	/**
	 * Returns the frame bases of all frames.
	 * @param frames The call stack, bottom (index 0) to top (last index).
	 * @param access The remote access.
	 * @returns Per frame: the base, an error, or undefined (no C frame).
	 */
	public async getFrameBases(frames: CFrameAddr[], access: CFrameAccess): Promise<Array<CFrameBase | undefined>> {
		const bases = new Array<CFrameBase | undefined>(frames.length).fill(undefined);
		const sp = access.getRegister('SP');
		let framePointer: number | undefined;	// The current link of the chain
		let previousBase = sp;	// Bases must increase towards the bottom of the stack
		let chainBroken = false;
		for (let i = frames.length - 1; i >= 0; i--) {
			const frame = frames[i];
			const func = this.table.functionAt(frame.addr);
			if (!func)
				continue;	// Not a C function
			const prologue = await this.getPrologue(func, access);
			if (!prologue.usesFrame)
				continue;	// No frame, does not use the chain
			if (framePointer === undefined)
				framePointer = access.getRegister(prologue.register.toUpperCase());
			if (i === frames.length - 1) {
				const base = await this.topFrameBaseFromSp(func, prologue, frame.addr, access);
				if (base !== undefined) {
					bases[i] = {base};
					previousBase = base;
					continue;	// The frame pointer is still the caller's
				}
			}
			if (chainBroken || framePointer < previousBase || framePointer > 0xFFFE) {
				chainBroken = true;
				bases[i] = {error: '<frame not found>'};
				continue;
			}
			bases[i] = {base: framePointer};
			previousBase = framePointer;
			const saved = await access.read(framePointer, 2);
			framePointer = saved[0] | (saved[1] << 8);
		}
		return bases;
	}
}


/** The frame pointer chain of the C frames on the stack, as far as it is
 * plausible: each frame saves the caller's frame pointer at (fp+0) and has
 * its return address at (fp+2). A link is accepted if the frame pointers
 * increase, stay below the top of the stack, and the return address follows
 * a CALL (or is a trampoline return, see bankedcalls.ts). The chain ends at
 * the first link that fails.
 * @param fp The frame pointer register (IX, or IY).
 * @param sp The stack pointer.
 * @param top The end (exclusive) of the stack.
 * @param read Reads memory (64k address).
 * @param isTrampolineReturn True for a banked call trampoline's return address.
 * @param maxLinks The maximum number of links.
 * @returns The addresses of the return address slots and the span
 * [start, end) of the chain, or undefined if there is no chain.
 */
export async function framePointerChain(fp: number, sp: number, top: number, read: (addr64k: number, size: number) => Promise<Uint8Array>,
	isTrampolineReturn: (addr64k: number) => boolean, maxLinks = 100): Promise<{slots: Set<number>, start: number, end: number} | undefined> {
	const slots = new Set<number>();
	let start: number | undefined;
	let prev = sp - 1;
	for (let k = 0; k < maxLinks; k++) {
		if (fp <= prev || fp + 4 > top)
			break;
		const link = await read(fp, 4);
		const saved = link[0] | (link[1] << 8);
		const ret = link[2] | (link[3] << 8);
		let plausible = isTrampolineReturn(ret);
		if (!plausible) {
			const before = await read((ret - 3) & 0xFFFF, 3);
			plausible = before[0] === 0xCD || (before[0] & 0b11000111) === 0b11000100;	// CALL nn, CALL cc,nn
		}
		if (!plausible)
			break;
		start ??= fp;
		slots.add(fp + 2);
		prev = fp;
		fp = saved;
	}
	if (start === undefined)
		return undefined;
	return {slots, start, end: prev + 4};
}
