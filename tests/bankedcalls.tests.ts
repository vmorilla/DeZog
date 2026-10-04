import * as assert from 'assert';
import {suite, test, setup} from 'mocha';
import {BankedCallConvention, BankedCallRuntime, Z88dkZxnBankedCall, assignBankedCalls, detectBankedCallConvention} from '../src/remotes/bankedcalls';
import {framePointerChain} from '../src/variables/cframes';


// The code of z88dk's +zxn banked_call and _initbankedsp, as linked into the
// ZX Next sample project (z88dk v26256): banked_call = $805A, tempsp = $98C8,
// mainsp = $98CB, cur_bank = $98CA, l_jphl = $8EE4, _initbankedsp = $803F.
const INIT_BANKED_SP = [0xED, 0x73, 0xC8, 0x98, 0x21, 0x9C, 0xFF, 0x39, 0xF9, 0xCD, 0x79, 0x96, 0xE5, 0xC1, 0xED, 0x7B];
const BANKED_CALL = [0xF3, 0xE1, 0xED, 0x73, 0xCB, 0x98, 0xED, 0x7B, 0xC8, 0x98, 0x3A, 0xCA, 0x98, 0xF5, 0x5E, 0x23, 0x56, 0x23, 0x7E, 0x23, 0x23, 0xE5,
	0xED, 0x73, 0xC8, 0x98, 0xED, 0x7B, 0xCB, 0x98, 0x32, 0xCA, 0x98, 0xCD, 0x9F, 0x80, 0xFB, 0xEB, 0xCD, 0xE4, 0x8E, 0xF3, 0xED, 0x73, 0xCB, 0x98,
	0xED, 0x7B, 0xC8, 0x98, 0xC1, 0xF1, 0xED, 0x73, 0xC8, 0x98, 0xED, 0x7B, 0xCB, 0x98, 0xC5, 0x32, 0xCA, 0x98, 0xCD, 0x9F, 0x80, 0xFB, 0xC9,
	0xED, 0x92, 0x50, 0x3C, 0x20, 0x01, 0x3D, 0xED, 0x92, 0x51, 0xC9];

const MAP_SYMBOLS: {[key: string]: number} = {
	'zxn_banked_call:banked_call': 0x805A,
	'zxn_banked_call:tempsp': 0x98C8,
	'zxn_banked_call:_initbankedsp': 0x803F,
	'zxn_banked_call:banking_mmu_low': 0x50,
	'zxn_banked_call:banking_mmu_high': 0x51,
	':__register_sp': 0xBFF0
};


suite('Banked calls (z88dk zxn banked_call)', () => {
	let mem: Uint8Array;
	let slots: number[];
	let rt: BankedCallRuntime;
	let convention: BankedCallConvention;
	const poke = (addr: number, ...bytes: number[]) => mem.set(bytes, addr);
	const pokeWord = (addr: number, v: number) => poke(addr, v & 0xFF, v >>> 8);
	// Long address: page in bits 16+ (+1), as DeZog's memory models
	const long = (addr64k: number, s = slots) => addr64k + ((s[addr64k >>> 13] + 1) << 16);

	setup(() => {
		mem = new Uint8Array(0x10000);
		poke(0x803F, ...INIT_BANKED_SP);
		poke(0x805A, ...BANKED_CALL);
		// Page 20 in slots 0/1 (factorial), main in slot 4
		slots = [20, 21, 10, 11, 4, 5, 0, 1];
		rt = {
			read: async (addr, size) => mem.slice(addr, addr + size),
			getSlots: () => slots,
			createLongAddress: (addr64k, s) => long(addr64k, s)
		};
		convention = detectBankedCallConvention({getSymbol: (name, module) => MAP_SYMBOLS[(module ?? '') + ':' + name]})!;

		// The third recursion level of factorial(5) (as seen live in jnext):
		// main ($9698: call banked_call / defq factorial) -> factorial(5) ->
		// factorial(4) -> factorial(3). factorial calls itself at $0024 (page 20).
		poke(0x9698, 0xCD, 0x5A, 0x80, 0x00, 0x00, 0x14, 0x00);	// call banked_call / defq $0000, page 20
		poke(0x0024, 0xCD, 0x5A, 0x80, 0x00, 0x00, 0x14, 0x00);
		// The banked stack, innermost first: return address (after the defq), saved bank (AF: A above F)
		pokeWord(0x98C8, 0xBFE4);	// tempsp
		poke(0xBFE4, 0x2B, 0x00, 0x44, 0x14);	// factorial(3) called from factorial(4), bank 20
		poke(0xBFE8, 0x2B, 0x00, 0x44, 0x14);	// factorial(4) called from factorial(5), bank 20
		poke(0xBFEC, 0x9F, 0x96, 0x44, 0xFF);	// factorial(5) called from main, bank $FF (ROM)
	});

	test('detection from the map file', () => {
		assert.ok(convention instanceof Z88dkZxnBankedCall);
		assert.equal(convention.name, 'z88dk zxn banked_call');
		// Without the banked stack pointer it is not this convention
		const without = detectBankedCallConvention({getSymbol: (name, module) => (name === 'tempsp') ? undefined : MAP_SYMBOLS[(module ?? '') + ':' + name]});
		assert.equal(without, undefined);
		assert.equal(detectBankedCallConvention({getSymbol: () => undefined}), undefined);
	});

	test('verification of the code', async () => {
		assert.equal(convention.isTrampolineReturn(0x8083), false);	// Not verified yet
		assert.ok(await convention.verify(rt));
		// The return address after "call l_jphl"
		assert.ok(convention.isTrampolineReturn(0x8083));
		assert.ok(!convention.isTrampolineReturn(0x8080));
		// The banked stack: the 100 bytes below __register_sp
		assert.equal(convention.getMainStackTop(), 0xBFF0 - 100);
	});

	test('unknown code is not used, and verified again later', async () => {
		poke(0x805A, 0x00);	// Other code
		assert.equal(await convention.verify(rt), false);
		assert.ok(!convention.isTrampolineReturn(0x8083));
		assert.deepEqual(await convention.getActiveCalls(rt, 3), []);
		// E.g. the program was not loaded yet
		poke(0x805A, ...BANKED_CALL);
		assert.ok(await convention.verify(rt));
	});

	test('the active banked calls', async () => {
		await convention.verify(rt);
		const calls = await convention.getActiveCalls(rt, 3);
		assert.deepEqual(calls, [
			{callerAddr: long(0x0024), targetAddr: long(0x0000)},	// factorial(4) -> factorial(3)
			{callerAddr: long(0x0024), targetAddr: long(0x0000)},	// factorial(5) -> factorial(4)
			{callerAddr: long(0x9698), targetAddr: long(0x0000)}	// main -> factorial(5)
		]);
		assert.equal(calls[0].callerAddr, 0x150024);	// Page 20
		assert.equal(calls[2].callerAddr, 0x59698);	// Page 4
		assert.deepEqual(await convention.getActiveCalls(rt, 0), []);
	});

	test('a caller in a bank that is not paged in', async () => {
		await convention.verify(rt);
		// factorial(3) was called from page 22 (the caller's code is not visible now)
		poke(0xBFE4, 0x2B, 0x00, 0x44, 0x16);
		const [innermost] = await convention.getActiveCalls(rt, 1);
		assert.equal(innermost.callerAddr, 0x170024);	// Page 22
		assert.equal(innermost.targetAddr, undefined);	// Its defq cannot be read
	});

	test('the length of a banked call for step over', async () => {
		await convention.verify(rt);
		assert.equal(convention.getCallLength(0x9698, mem.slice(0x9698, 0x969B)), 7);
		assert.equal(convention.getCallLength(0x1000, new Uint8Array([0xCD, 0x00, 0x90])), undefined);	// Other call
		assert.equal(convention.getCallLength(0x1000, new Uint8Array([0xC3, 0x5A, 0x80])), undefined);	// JP banked_call
	});

	test('assignment to the trampoline returns on the main stack', async () => {
		await convention.verify(rt);
		const calls = await convention.getActiveCalls(rt, 3);
		// Oldest first: main's area, T(factorial 5), argument 4, T(factorial 4), argument 3, T(factorial 3)
		const stack = [0x1234, 0x8083, 0x0004, 0x8083, 0x0003, 0x8083];
		const map = assignBankedCalls(stack, convention, calls);
		assert.deepEqual([...map.keys()], [1, 3, 5]);
		assert.equal(map.get(1), calls[2]);	// The oldest trampoline is the outermost call (from main)
		assert.equal(map.get(5), calls[0]);	// The newest is the innermost
		// More trampolines than records: the extra (oldest) ones get none
		assert.deepEqual([...assignBankedCalls([0x8083, ...stack], convention, calls).keys()], [2, 4, 6]);
	});
});


suite('Frame pointer chain (C frames)', () => {
	let mem: Uint8Array;
	const read = async (addr: number, size: number) => mem.slice(addr, addr + size);
	const isTrampoline = (addr: number) => addr === 0x8083;
	const pokeWord = (addr: number, v: number) => mem.set([v & 0xFF, v >>> 8], addr);

	setup(() => {
		mem = new Uint8Array(0x10000);
		mem.set([0xCD, 0x00, 0x00], 0x0000);	// call ___sdcc_enter_ix at $0000: "$0003" looks like a return address
		mem.set([0xCD, 0x5A, 0x80], 0x9698);	// call banked_call in main
		// factorial(3) @BF7A -> factorial(4) @BF86 -> factorial(5) @BF92 (frame pointers),
		// each called through the trampoline; the argument 3 lies between them
		pokeWord(0xBF7A, 0xBF86); pokeWord(0xBF7C, 0x8083);
		pokeWord(0xBF84, 0x0003);	// The argument pushed by factorial(4): data
		pokeWord(0xBF86, 0xBF92); pokeWord(0xBF88, 0x8083);
		pokeWord(0xBF92, 0x1234); pokeWord(0xBF94, 0x8083);	// Saved: main's IX (garbage)
	});

	test('the slots of the return addresses and the span', async () => {
		const chain = (await framePointerChain(0xBF7A, 0xBF70, 0xBF8C + 100, read, isTrampoline))!;
		assert.deepEqual([...chain.slots], [0xBF7C, 0xBF88, 0xBF94]);
		assert.equal(chain.start, 0xBF7A);
		assert.equal(chain.end, 0xBF96);
		// The argument "$0003" is inside the span but not a slot: data
		assert.ok(0xBF84 >= chain.start && 0xBF84 < chain.end && !chain.slots.has(0xBF84));
	});

	test('the chain ends at the first implausible link', async () => {
		pokeWord(0xBF88, 0x4000);	// Not after a CALL
		const chain = (await framePointerChain(0xBF7A, 0xBF70, 0xC000, read, isTrampoline))!;
		assert.deepEqual([...chain.slots], [0xBF7C]);
		assert.equal(chain.end, 0xBF7E);
		// A return address after a CALL is plausible as well
		pokeWord(0xBF88, 0x969B);
		assert.deepEqual([...(await framePointerChain(0xBF7A, 0xBF70, 0xC000, read, isTrampoline))!.slots], [0xBF7C, 0xBF88, 0xBF94]);
	});

	test('no chain', async () => {
		assert.equal(await framePointerChain(0xBF6E, 0xBF70, 0xC000, read, isTrampoline), undefined);	// Below SP
		assert.equal(await framePointerChain(0xBF7A, 0xBF70, 0xBF7C, read, isTrampoline), undefined);	// Above the top
		pokeWord(0xBF7C, 0x4000);
		assert.equal(await framePointerChain(0xBF7A, 0xBF70, 0xC000, read, isTrampoline), undefined);	// First link implausible
		// Frame pointers must increase
		pokeWord(0xBF7C, 0x8083);
		pokeWord(0xBF7A, 0xBF70);
		assert.deepEqual([...(await framePointerChain(0xBF7A, 0xBF70, 0xC000, read, isTrampoline))!.slots], [0xBF7C]);
	});
});
