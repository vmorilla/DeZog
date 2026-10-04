/**
 * Banked calls: calls that page in the called function's bank through a
 * trampoline, e.g. z88dk's "banked_call" for "__banked" functions.
 * A trampoline hides the caller from a plain stack analysis: the caller's
 * return address is kept elsewhere (z88dk zxn: on a separate "banked
 * stack") and the main stack only holds a return address into the
 * trampoline. See design/c-variables.md, section 12.D.
 *
 * A convention describes one such mechanism. The call stack and stepping
 * code only use the BankedCallConvention interface; further architectures
 * are added as new implementations in BANKED_CALL_CONVENTIONS.
 */


/** Access to the map file's symbols, for the detection. */
export interface BankedCallMapAccess {
	/// The value of a symbol. With module: the symbol of that module (local
	/// or public), without: a public symbol, or any symbol of that name.
	getSymbol(name: string, module?: string): number | undefined;
}


/** Access to the machine at run time. */
export interface BankedCallRuntime {
	/// Reads memory (64k address).
	read(addr64k: number, size: number): Promise<Uint8Array>;
	/// The current slot/bank configuration.
	getSlots(): number[];
	/// Converts a 64k address into a long address, optionally with other slots.
	createLongAddress(addr64k: number, slots?: number[]): number;
}


/** An active banked call. */
export interface ActiveBankedCall {
	/// The address of the call instruction in the caller (long address).
	callerAddr: number;
	/// The called function (long address), undefined if not known.
	targetAddr: number | undefined;
}


/** A banked call mechanism. */
export interface BankedCallConvention {
	/// A name for messages, e.g. "z88dk zxn banked_call".
	readonly name: string;

	/** Checks (once) that the code in memory is the expected one.
	 * @returns false if not: the convention must not be used.
	 */
	verify(rt: BankedCallRuntime): Promise<boolean>;

	/** True if the value (from the main stack) is the trampoline's return
	 * address, i.e. a banked call is active at this point of the stack. */
	isTrampolineReturn(value64k: number): boolean;

	/** The active banked calls, innermost first.
	 * @param count The number of trampoline return addresses found on the main stack.
	 */
	getActiveCalls(rt: BankedCallRuntime, count: number): Promise<ActiveBankedCall[]>;

	/** The end (exclusive, 64k) of the main stack if the convention keeps
	 * data above it (that must not be analyzed as stack), otherwise undefined. */
	getMainStackTop(): number | undefined;

	/** The length of a banked call sequence (call instruction plus inline
	 * data) at the given address, otherwise undefined. For step over.
	 * @param bytes At least 3 bytes of code at pc.
	 */
	getCallLength(pc64k: number, bytes: Uint8Array): number | undefined;
}


/**
 * z88dk "+zxn", module "zxn_banked_call" (target/zxn/far/zxn_banked_call.asm):
 *
 *   caller:      call banked_call ; defq target   ; target: address (2), bank (1), 0
 *   banked_call: di / pop hl / ld (mainsp),sp / ld sp,(tempsp)
 *                ld a,(cur_bank) / push af        ; the previous bank, on the banked stack
 *                ...hl += 4 / push hl             ; the real return address, on the banked stack
 *                ld (tempsp),sp / ld sp,(mainsp) / page in
 *                ei / ex de,hl / call l_jphl     ; calls the target, pushes the
 *                                                 ; trampoline return on the main stack
 *                ... pops both from the banked stack, restores the bank, returns
 *   _initbankedsp: ld (tempsp),sp / ld hl,-N / add hl,sp / ld sp,hl
 *                ; the banked stack is the N bytes below __register_sp
 *
 * A banked stack entry (4 bytes, innermost at tempsp): the real return
 * address (after the defq), then the saved bank (pushed as AF: A above F).
 * The bank is the 8k page of the first banked slot, the next slot gets bank+1.
 */
export class Z88dkZxnBankedCall implements BankedCallConvention {
	public readonly name = 'z88dk zxn banked_call';

	/// The trampoline return address, from the code (verify).
	protected trampolineReturn: number | undefined;
	/// The banked stack size N, from the code of _initbankedsp (verify).
	protected bankedStackSize: number | undefined;
	/// True once verify succeeded. A failure is not remembered: the code may
	/// not have been loaded yet.
	protected verified = false;

	/**
	 * @param bankedCall The address of banked_call.
	 * @param tempsp The address of the banked stack pointer variable.
	 * @param initBankedSp The address of _initbankedsp, or undefined.
	 * @param registerSp __register_sp (the top of the banked stack), or undefined.
	 * @param bankedSlots The slots the bank is paged into (from banking_mmu_low/high).
	 */
	constructor(protected bankedCall: number, protected tempsp: number, protected initBankedSp: number | undefined,
		protected registerSp: number | undefined, protected bankedSlots: number[]) {}


	/** Creates the convention if the map file contains its symbols. */
	public static detect(map: BankedCallMapAccess): BankedCallConvention | undefined {
		const module = 'zxn_banked_call';
		const bankedCall = map.getSymbol('banked_call', module);
		const tempsp = map.getSymbol('tempsp', module);
		if (bankedCall === undefined || tempsp === undefined)
			return undefined;
		// NEXTREG $50+n pages slot n
		const mmuLow = map.getSymbol('banking_mmu_low', module) ?? 0x50;
		const mmuHigh = map.getSymbol('banking_mmu_high', module) ?? 0x51;
		const bankedSlots = [mmuLow - 0x50, mmuHigh - 0x50].filter(s => s >= 0 && s < 8);
		return new Z88dkZxnBankedCall(bankedCall & 0xFFFF, tempsp & 0xFFFF, map.getSymbol('_initbankedsp', module),
			map.getSymbol('__register_sp'), bankedSlots);
	}


	public async verify(rt: BankedCallRuntime): Promise<boolean> {
		if (this.verified)
			return true;
		const code = await rt.read(this.bankedCall, 0x40);
		// di / pop hl / ld (nn),sp / ld sp,(tempsp)
		const word = (k: number) => code[k] | (code[k + 1] << 8);
		if (code[0] !== 0xF3 || code[1] !== 0xE1 || code[2] !== 0xED || code[3] !== 0x73 || code[6] !== 0xED || code[7] !== 0x7B || word(8) !== this.tempsp)
			return false;
		// ei / ex de,hl / call nn: the trampoline return is after the call
		for (let k = 10; k < code.length - 4; k++) {
			if (code[k] === 0xFB && code[k + 1] === 0xEB && code[k + 2] === 0xCD) {
				this.trampolineReturn = (this.bankedCall + k + 5) & 0xFFFF;
				break;
			}
		}
		if (this.trampolineReturn === undefined)
			return false;
		// _initbankedsp: ld (tempsp),sp / ld hl,-N
		if (this.initBankedSp !== undefined) {
			const init = await rt.read(this.initBankedSp & 0xFFFF, 7);
			if (init[0] === 0xED && init[1] === 0x73 && (init[2] | (init[3] << 8)) === this.tempsp && init[4] === 0x21)
				this.bankedStackSize = 0x10000 - (init[5] | (init[6] << 8));
		}
		this.verified = true;
		return true;
	}


	public isTrampolineReturn(value64k: number): boolean {
		return this.verified && value64k === this.trampolineReturn;
	}


	/** The slots with the bank paged in as banked_call does it. */
	protected slotsWithBank(rt: BankedCallRuntime, bank: number): number[] {
		const slots = [...rt.getSlots()];
		this.bankedSlots.forEach((slot, k) => {
			// The ROM (0xFF) occupies both slots, a RAM bank and the next one otherwise
			slots[slot] = (bank === 0xFF) ? 0xFF : bank + k;
		});
		return slots;
	}


	public async getActiveCalls(rt: BankedCallRuntime, count: number): Promise<ActiveBankedCall[]> {
		if (!this.verified || count <= 0)
			return [];
		const sp = (await rt.read(this.tempsp, 2));
		const bankedSp = sp[0] | (sp[1] << 8);
		const entries = await rt.read(bankedSp, 4 * count);
		const calls: ActiveBankedCall[] = [];
		for (let i = 0; i < count; i++) {
			const ret = entries[4 * i] | (entries[4 * i + 1] << 8);	// After the defq
			const savedBank = entries[4 * i + 3];	// A of AF
			const callSite = (ret - 7) & 0xFFFF;
			const callerAddr = rt.createLongAddress(callSite, this.slotsWithBank(rt, savedBank));
			// The target from the defq, if the caller's code is paged in
			let targetAddr: number | undefined;
			if (callerAddr === rt.createLongAddress(callSite)) {
				const defq = await rt.read((ret - 4) & 0xFFFF, 3);
				const target = defq[0] | (defq[1] << 8);
				targetAddr = rt.createLongAddress(target, this.slotsWithBank(rt, defq[2]));
			}
			calls.push({callerAddr, targetAddr});
		}
		return calls;
	}


	public getMainStackTop(): number | undefined {
		if (this.registerSp === undefined || this.bankedStackSize === undefined)
			return undefined;
		return ((this.registerSp & 0xFFFF) - this.bankedStackSize) & 0xFFFF;
	}


	public getCallLength(pc64k: number, bytes: Uint8Array): number | undefined {
		if (bytes[0] === 0xCD && (bytes[1] | (bytes[2] << 8)) === this.bankedCall)
			return 7;	// call banked_call (3) + defq (4)
		return undefined;
	}
}


/** The known conventions. Each detects itself from the map file. */
export const BANKED_CALL_CONVENTIONS: Array<(map: BankedCallMapAccess) => BankedCallConvention | undefined> = [
	map => Z88dkZxnBankedCall.detect(map)
];


/** Returns the first convention found in the map file, or undefined. */
export function detectBankedCallConvention(map: BankedCallMapAccess): BankedCallConvention | undefined {
	for (const detect of BANKED_CALL_CONVENTIONS) {
		const convention = detect(map);
		if (convention)
			return convention;
	}
	return undefined;
}


/** Assigns the active banked calls to the trampoline return addresses on
 * the main stack.
 * @param stack The stack values, oldest (top of stack) first, as DeZog analyzes them.
 * @param convention The convention.
 * @param calls The active calls, innermost first (see getActiveCalls).
 * @returns Stack index -> active call.
 */
export function assignBankedCalls(stack: number[], convention: BankedCallConvention, calls: ActiveBankedCall[]): Map<number, ActiveBankedCall> {
	const indexes = stack.map((v, i) => convention.isTrampolineReturn(v) ? i : -1).filter(i => i >= 0);
	const result = new Map<number, ActiveBankedCall>();
	// The newest trampoline (closest to SP) is the innermost call
	indexes.forEach((index, t) => {
		const call = calls[indexes.length - 1 - t];
		if (call)
			result.set(index, call);
	});
	return result;
}
