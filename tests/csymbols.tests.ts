import * as assert from 'assert';
import {suite, test, setup, teardown} from 'mocha';
import {Labels, LabelsClass} from '../src/labels/labels';
import {Expressions} from '../src/misc/expressions';
import {MemoryModelZxNext} from '../src/remotes/MemoryModel/zxnextmemorymodels';
import {WorkspacePaths} from '../src/misc/workspacepaths';
import {CType, decodeCdbSymbolName, parseCdbRecord, parseCdbType} from '../src/labels/z88dkcdb';
import {CValueFormatter, decodeFloat, decodeMath48, registerName, stackSource} from '../src/variables/cvars';
import {CFrameAccess, CFrameResolver} from '../src/variables/cframes';


suite('sdcc CDB records (z88dk -debug)', () => {

	test('decodeCdbSymbolName', () => {
		assert.equal(decodeCdbSymbolName('S_3aG_24player_240_5f0_240_28_7b13_7dSTsprite_3aS_29_2cE_2c0_2c0'),
			'S:G$player$0_0$0({13}STsprite:S),E,0,0');
		assert.equal(decodeCdbSymbolName('M_3amain'), 'M:main');
	});

	test('parseCdbType', () => {
		assert.deepEqual(parseCdbType('{2}SI:S'), {type: {kind: 'int', size: 2, signed: true, isChar: false}, size: 2});
		assert.deepEqual(parseCdbType('{1}SC:U').type, {kind: 'int', size: 1, signed: false, isChar: true});
		assert.deepEqual(parseCdbType('{4}SL:S').type, {kind: 'int', size: 4, signed: true, isChar: false});
		assert.deepEqual(parseCdbType('{8}SLL:U').type, {kind: 'int', size: 8, signed: false, isChar: false});
		assert.deepEqual(parseCdbType('{4}SF:S').type, {kind: 'float', size: 4});
		assert.deepEqual(parseCdbType('{13}STsprite:S').type, {kind: 'struct', tag: 'sprite'});
		// Array of structs: element size from the total size
		assert.deepEqual(parseCdbType('{12}DA3d,STpoint:S'), {
			type: {kind: 'array', length: 3, size: 12, elem: {kind: 'struct', tag: 'point'}},
			size: 12
		});
		// Array of char
		assert.deepEqual(parseCdbType('{6}DA6d,SC:U').type, {
			kind: 'array', length: 6, size: 6, elem: {kind: 'int', size: 1, signed: false, isChar: true}
		});
		// Pointers
		assert.deepEqual(parseCdbType('{2}DG,SC:U').type, {kind: 'pointer', target: {kind: 'int', size: 1, signed: false, isChar: true}});
		assert.deepEqual(parseCdbType('{2}DG,STpoint:S').type, {kind: 'pointer', target: {kind: 'struct', tag: 'point'}});
		// Function returning int
		assert.deepEqual(parseCdbType('{2}DF,SI:S').type, {kind: 'function', ret: {kind: 'int', size: 2, signed: true, isChar: false}});
		// Bitfield
		assert.deepEqual(parseCdbType('{1}SB3$2:U').type, {kind: 'bitfield', bitOffset: 3, bitWidth: 2, signed: false});
		// Unknown
		assert.equal(parseCdbType('{3}SX:U').type.kind, 'unknown');
		assert.equal(parseCdbType('nonsense').type.kind, 'unknown');
	});

	test('parseCdbRecord: module and function', () => {
		assert.deepEqual(parseCdbRecord('M:vars'), {kind: 'module', name: 'vars'});
		const f = parseCdbRecord('F:G$sum_points$0_0$0({2}DF,SI:S),C,0,0,0,0,0')!;
		assert.equal(f.kind, 'function');
		if (f.kind !== 'function')
			return;
		assert.equal(f.symbol.scope, 'G');
		assert.equal(f.symbol.name, 'sum_points');
		assert.equal(f.symbol.addressSpace, 'C');
	});

	test('parseCdbRecord: symbols', () => {
		const get = (text: string) => {
			const r = parseCdbRecord(text)!;
			assert.equal(r.kind, 'symbol', text);
			return (r as any).symbol;
		};
		// Global
		let s = get('S:G$player$0_0$0({13}STsprite:S),E,0,0');
		assert.equal(s.scope, 'G');
		assert.equal(s.name, 'player');
		assert.equal(s.size, 13);
		assert.equal(s.addressSpace, 'E');
		assert.equal(s.onStack, false);
		// File static
		s = get('S:Fvars$file_static$0_0$0({1}SC:U),E,0,0');
		assert.equal(s.scope, 'F');
		assert.equal(s.cModule, 'vars');
		assert.equal(s.name, 'file_static');
		// Stack local
		s = get('S:Lvars.sum_points$i$1_0$9({1}SC:U),B,1,-1');
		assert.equal(s.scope, 'L');
		assert.equal(s.cModule, 'vars');
		assert.equal(s.func, 'sum_points');
		assert.equal(s.level, 1);
		assert.equal(s.subLevel, 0);
		assert.equal(s.block, 9);
		assert.equal(s.addressSpace, 'B');
		assert.equal(s.onStack, true);
		assert.equal(s.stackOffset, -1);
		// Register local
		s = get('S:Lvars.sum_points$total$4_0$12({2}SI:S),R,0,0,[c,b]');
		assert.equal(s.level, 4);
		assert.equal(s.block, 12);
		assert.equal(s.addressSpace, 'R');
		assert.deepEqual(s.registers, ['c', 'b']);
		// Local without module (older format)
		s = get('S:Lfactorial$n$1_0$7({2}SI:S),B,1,4');
		assert.equal(s.func, 'factorial');
		assert.equal(s.cModule, undefined);
		assert.equal(s.stackOffset, 4);
		// Old level format "$1$0"
		s = get('S:G$old$1$0({2}SI:S),E,0,0');
		assert.equal(s.level, 1);
		assert.equal(s.subLevel, 0);
		assert.equal(s.block, 0);
	});

	test('parseCdbRecord: struct', () => {
		const r = parseCdbRecord('T:Fvars$sprite[({0}S:S$pos$0_0$0({4}STpoint:S),Z,0,0)({4}S:S$frame$0_0$0({1}SC:U),Z,0,0)({5}S:S$name$0_0$0({6}DA6d,SC:U),Z,0,0)({11}S:S$next$0_0$0({2}DG,STsprite:S),Z,0,0)]')!;
		assert.equal(r.kind, 'type');
		if (r.kind !== 'type')
			return;
		assert.equal(r.struct.cModule, 'vars');
		assert.equal(r.struct.tag, 'sprite');
		assert.deepEqual(r.struct.members.map(m => [m.name, m.offset, m.size]),
			[['pos', 0, 4], ['frame', 4, 1], ['name', 5, 6], ['next', 11, 2]]);
		assert.deepEqual(r.struct.members[3].type, {kind: 'pointer', target: {kind: 'struct', tag: 'sprite'}});
	});

	test('parseCdbRecord: unknown', () => {
		assert.equal(parseCdbRecord('X:whatever'), undefined);
		assert.equal(parseCdbRecord('S:garbage'), undefined);
	});
});


suite('C symbol table (z88dk -debug, sdcc)', () => {
	const dir = 'tests/data/labels/projects/z88dk/c_vars_v2';
	// Long address for the ZX Next: page in bits 16+ (+1)
	const page = (p: number, addr64k: number) => addr64k + ((p + 1) << 16);
	let lbls: LabelsClass;

	setup(() => {
		lbls = new LabelsClass();
		(WorkspacePaths as any).rootPath = undefined;
		lbls.readListFiles({
			z88dkv2: [{
				path: './' + dir + '/*.lis',
				mapFile: './' + dir + '/probe.map',
				srcDirs: [dir],
				excludeFiles: []
			}]
		} as any, new MemoryModelZxNext());
	});

	test('functions and their address ranges', () => {
		const c = lbls.cSymbols;
		assert.ok(c.hasCdb());
		// _sum_points = $8F85 (slot 4 = page 4)
		assert.equal(c.functionAt(page(4, 0x8F85))?.cName, 'sum_points');
		assert.equal(c.functionAt(page(4, 0x8F90))?.cName, 'sum_points');
		assert.equal(c.functionAt(page(4, 0x8F78))?.cName, 'leaf');
		assert.equal(c.functionAt(page(4, 0x903C))?.linkerName, '_main');
		// Banked: _banked_fn = $140000 -> page 20
		assert.equal(c.functionAt(page(20, 0x0000))?.cName, 'banked_fn');
		assert.equal(c.functionAt(page(20, 0x0005))?.module, 'banked_c');
		// The function ends at the slot boundary (8k slot 0 for page 20)
		assert.equal(c.functionAt(page(20, 0x1FFF))?.cName, 'banked_fn');
		assert.equal(c.functionAt(page(20, 0x2000)), undefined);
		// Not in a C function
		assert.equal(c.functionAt(page(4, 0x8F00)), undefined);
		assert.equal(c.functionAt(page(5, 0x8F85)), undefined);	// Other page
	});

	test('globals', () => {
		const c = lbls.cSymbols;
		const names = c.getGlobals().map(v => v.cName);
		assert.deepEqual(names, ['big', 'colour', 'global_counter', 'global_init', 'player', 'points', 'ptr', 'ratio', 'word']);
		const player = c.resolveStatic('player')!;
		assert.equal(player.linkerName, '_player');
		assert.deepEqual(player.storage, {kind: 'static', longAddress: page(4, 0x9280)});
		assert.equal(player.size, 13);
		assert.deepEqual(player.type, {kind: 'struct', tag: 'sprite'});
		assert.equal(c.resolveStatic('points')!.size, 12);
		// Functions and header declarations are not globals
		assert.equal(c.resolveStatic('main'), undefined);
	});

	test('statics in C scope order', () => {
		const c = lbls.cSymbols;
		const inMain = page(4, 0x903C);
		const inWithStatic = page(4, 0x8FCC);
		// File static: only in a function of its module
		assert.deepEqual(c.resolveStatic('file_static', inMain)?.storage, {kind: 'static', longAddress: page(4, 0x9277)});
		assert.equal(c.resolveStatic('file_static'), undefined);
		assert.equal(c.resolveStatic('file_static', page(20, 0x0000)), undefined);	// banked.c
		// Function static: mangled linker name
		const calls = c.resolveStatic('calls', inWithStatic)!;
		assert.equal(calls.linkerName, '_with_static_calls_10000_14');
		assert.deepEqual(calls.storage, {kind: 'static', longAddress: page(4, 0x92A4)});
		assert.equal(c.resolveStatic('calls', inMain), undefined);
		// Globals from anywhere, "::" forces the global
		assert.equal(c.resolveStatic('global_counter', inMain)?.linkerName, '_global_counter');
		assert.equal(c.resolveStatic('::player', inMain)?.linkerName, '_player');
		// The statics scope of a function: function statics first, then file statics
		const func = c.functionAt(inWithStatic)!;
		assert.deepEqual(c.getStatics(func).map(v => v.cName), ['calls', 'file_static']);
	});

	test('locals', () => {
		const c = lbls.cSymbols;
		const func = c.functionAt(page(4, 0x8F85))!;
		const locals = func.locals.map(v => [v.cName, v.level, v.block, JSON.stringify(v.storage)]);
		assert.deepEqual(locals.sort(), [
			['count', 1, 8, '{"kind":"stack","offset":6}'],
			['dx', 3, 11, '{"kind":"register","registers":["l","h"]}'],
			['i', 1, 9, '{"kind":"stack","offset":-1}'],
			['p', 1, 8, '{"kind":"stack","offset":4}'],
			['total', 1, 9, '{"kind":"register","registers":["e","d"]}'],
			['total', 4, 12, '{"kind":"register","registers":["c","b"]}']
		].sort());
		// Compiler temporaries are not listed
		const longs = c.functionAt(page(4, 0x8FEE))!;
		assert.equal(longs.cName, 'longs');
		assert.ok(!longs.locals.some(v => v.cName.startsWith('sloc')));
		assert.deepEqual(longs.locals.find(v => v.cName === 'local_sprite')?.storage, {kind: 'stack', offset: -17});
		// Banked function
		const banked = c.functionAt(page(20, 0x0000))!;
		assert.deepEqual(banked.locals.map(v => v.cName).sort(), ['c', 'x', 'y']);
	});

	test('visible locals per line (nested blocks, shadowing)', () => {
		const c = lbls.cSymbols;
		const func = c.functionAt(page(4, 0x8F85))!;
		const at = (addr: number) => c.visibleLocals(func, page(4, addr)).map(l => l.v.cName + '@' + l.v.level + (l.shadowed ? '(shadowed)' : ''));
		// Line 29 (for): parameters first by offset, then level-1 locals
		assert.deepEqual(at(0x8F8C), ['p@1', 'count@1', 'i@1', 'total@1']);
		// Line 30 (inside the for body, level 3): dx
		assert.deepEqual(at(0x8F98), ['p@1', 'count@1', 'i@1', 'total@1', 'dx@3']);
		assert.deepEqual(at(0x8FAF), ['p@1', 'count@1', 'i@1', 'total@1', 'dx@3']);
		// Line 33 (inner block, level 4): the inner total shadows the outer one, dx still visible
		assert.deepEqual(at(0x8FB0), ['p@1', 'count@1', 'i@1', 'total@1(shadowed)', 'dx@3', 'total@4']);
		assert.deepEqual(at(0x8FB8), ['p@1', 'count@1', 'i@1', 'total@1(shadowed)', 'dx@3', 'total@4']);
		// Line 29 again (i++, level 2): the blocks have ended
		assert.deepEqual(at(0x8FC2), ['p@1', 'count@1', 'i@1', 'total@1']);
		// Line 37 (return)
		assert.deepEqual(at(0x8FC7), ['p@1', 'count@1', 'i@1', 'total@1']);
		// The function start
		assert.deepEqual(at(0x8F85), ['p@1', 'count@1', 'i@1', 'total@1']);
	});

	test('structs and sizes', () => {
		const c = lbls.cSymbols;
		const sprite = c.getStruct('sprite')!;
		assert.equal(sprite.size, 13);
		assert.equal(sprite.isUnion, false);
		assert.deepEqual(sprite.members.map(m => m.name), ['pos', 'frame', 'name', 'next']);
		const u16 = c.getStruct('u16')!;
		assert.equal(u16.isUnion, true);
		assert.equal(u16.size, 2);
		assert.equal(c.sizeOf({kind: 'struct', tag: 'point'}), 4);
		assert.equal(c.sizeOf(c.resolveStatic('points')!.type), 12);
		assert.equal(c.sizeOf({kind: 'pointer', target: {kind: 'void'}}), 2);
		assert.equal(c.getStruct('nonexistent'), undefined);
	});

	test('C names for display and the fallback lookup', () => {
		const c = lbls.cSymbols;
		assert.equal(c.getCName('_sum_points'), 'sum_points');
		assert.equal(c.getCName('_player'), 'player');
		assert.equal(c.getCName('_errno'), undefined);
		assert.equal(c.getCName('sum_points'), undefined);
		// Fallback: public "_x" symbols of C modules only
		assert.equal(c.fallbackLinkerName('main'), '_main');
		assert.equal(c.fallbackLinkerName('global_counter'), '_global_counter');
		assert.equal(c.fallbackLinkerName('errno'), undefined);	// Module "_errno" is assembler
		assert.equal(c.fallbackLinkerName('file_static'), undefined);	// Local symbol
		assert.equal(c.fallbackLinkerName('nonexistent'), undefined);
	});

	test('assembler labels are unchanged', () => {
		assert.equal(lbls.getNumberForLabel('_player'), page(4, 0x9280));
		assert.equal(lbls.getNumberForLabel('player'), undefined);
		assert.deepEqual(lbls.getLabelsForRegEx('__CDBINFO__'), []);
	});

	test('a map without CDB records', () => {
		const other = new LabelsClass();
		other.readListFiles({
			z88dkv2: [{
				path: './tests/data/labels/projects/z88dk/debug_v2/*.lis',
				mapFile: './tests/data/labels/projects/z88dk/debug_v2/main_nodebug.map',
				srcDirs: ['tests/data/labels/projects/z88dk/debug_v2'],
				excludeFiles: []
			}]
		} as any, new MemoryModelZxNext());
		assert.equal(other.cSymbols.hasCdb(), false);
		assert.equal(other.cSymbols.functionAt(0x58000), undefined);
	});
});


suite('C values (formatting)', () => {
	const dir = 'tests/data/labels/projects/z88dk/c_vars_v2';
	let fmt: CValueFormatter;
	let lbls: LabelsClass;
	const int = (size: number, signed: boolean, isChar = false): CType => ({kind: 'int', size, signed, isChar});

	setup(() => {
		lbls = new LabelsClass();
		(WorkspacePaths as any).rootPath = undefined;
		lbls.readListFiles({
			z88dkv2: [{path: './' + dir + '/*.lis', mapFile: './' + dir + '/probe.map', srcDirs: [dir], excludeFiles: []}]
		} as any, new MemoryModelZxNext());
		fmt = new CValueFormatter(lbls.cSymbols, 'math32');
	});

	test('math48 (bytes from "zcc +zx -lmath48")', () => {
		assert.equal(decodeMath48(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x40, 0x81])), 1.5);
		assert.equal(decodeMath48(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0xA4, 0x84])), -10.25);
		assert.ok(Math.abs(decodeMath48(new Uint8Array([0xCD, 0xCC, 0xCC, 0xCC, 0x4C, 0x7D])) - 0.1) < 1e-12);
		assert.equal(decodeMath48(new Uint8Array([0, 0, 0, 0, 0, 0])), 0);
	});

	test('decodeFloat', () => {
		// math32 = IEEE-754 single (bytes from sdcc: 1.5 = 00 00 C0 3F)
		assert.equal(decodeFloat(new Uint8Array([0x00, 0x00, 0xC0, 0x3F]), 'math32'), 1.5);
		assert.equal(decodeFloat(new Uint8Array([0x00, 0x00, 0x24, 0xC1]), 'math32'), -10.25);
		// Size the format cannot decode
		assert.equal(decodeFloat(new Uint8Array([0, 0, 0, 0, 0x40, 0x81]), 'math32'), undefined);
		assert.equal(decodeFloat(new Uint8Array([0x00, 0x00, 0xC0, 0x3F]), 'math48'), undefined);
		assert.equal(decodeFloat(new Uint8Array([0x00, 0x00, 0xC0, 0x3F]), 'raw'), undefined);
	});

	test('scalars', () => {
		const b = (...v: number[]) => new Uint8Array(v);
		assert.equal(fmt.format(int(2, true), b(0xFE, 0xFF), 0), '-2');
		assert.equal(fmt.format(int(2, false), b(0xFE, 0xFF), 0), '65534');
		assert.equal(fmt.format(int(4, true), b(0x40, 0xE2, 0x01, 0x00), 0), '123456');
		assert.equal(fmt.format(int(4, true), b(0xFF, 0xFF, 0xFF, 0xFF), 0), '-1');
		assert.equal(fmt.format(int(8, true), b(0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF), 0), '-1');
		assert.equal(fmt.format(int(1, false, true), b(0x41), 0), "65 'A'");
		assert.equal(fmt.format(int(1, true, true), b(0xFF), 0), '-1');
		assert.equal(fmt.format(int(1, false, true), b(0), 0), '0');
		assert.equal(fmt.format({kind: 'float', size: 4}, b(0x00, 0x00, 0xC0, 0x3F), 0), '1.5');
		assert.equal(new CValueFormatter(lbls.cSymbols, 'raw').format({kind: 'float', size: 4}, b(0x00, 0x00, 0xC0, 0x3F), 0), '[00 00 C0 3F]');
		assert.equal(fmt.format({kind: 'pointer', target: int(1, false, true)}, b(0x77, 0x92), 0), '0x9277');
		assert.equal(fmt.format({kind: 'pointer', target: int(1, false, true)}, b(0, 0), 0), 'NULL');
		// Offset
		assert.equal(fmt.format(int(2, true), b(0, 0x2A, 0x00), 1), '42');
		// Not enough bytes
		assert.equal(fmt.format(int(2, true), b(0x2A), 0), '<not readable>');
		// Bitfield: bits 3-4 of 0b00011000 = 3
		assert.equal(fmt.format({kind: 'bitfield', bitOffset: 3, bitWidth: 2, signed: false}, b(0x18), 0), '3');
		assert.equal(fmt.format({kind: 'bitfield', bitOffset: 3, bitWidth: 2, signed: true}, b(0x18), 0), '-1');
	});

	test('structs, arrays, unions (layouts from the probe)', () => {
		// struct sprite player = {{10, 20}, 3, "HERO", 0};
		const player = new Uint8Array([10, 0, 20, 0, 3, 0x48, 0x45, 0x52, 0x4F, 0, 0, 0, 0]);
		assert.equal(fmt.format({kind: 'struct', tag: 'sprite'}, player, 0, 'vars_c'),
			'{pos={x=10, y=20}, frame=3, name="HERO", next=NULL}');
		// point_t points[3]
		const points = new Uint8Array([1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]);
		const pointsType = lbls.cSymbols.resolveStatic('points')!.type;
		assert.equal(fmt.format(pointsType, points, 0, 'vars_c'), '[{x=1, y=0}, {x=2, y=0}, {x=0, y=0}]');
		// union u16: both members at offset 0
		assert.equal(fmt.format({kind: 'struct', tag: 'u16'}, new Uint8Array([0x34, 0x12]), 0, 'vars_c'), '{w=4660, b=[…]}');	// Nested arrays are not previewed
		assert.equal(fmt.format({kind: 'array', length: 2, size: 2, elem: int(1, false, true)}, new Uint8Array([0x34, 0x12]), 0), "[52 '4', 18]");
		// char arrays: a string only if the contents are one
		const chars: CType = {kind: 'array', length: 4, size: 4, elem: int(1, false, true)};
		assert.equal(fmt.format(chars, new Uint8Array([0x41, 0x42, 0, 0]), 0), '"AB"');
		assert.equal(fmt.format(chars, new Uint8Array([0, 0, 0, 0]), 0), '[0, 0, 0, 0]');
		assert.equal(fmt.format(chars, new Uint8Array([0x41, 0x42, 0x43, 0x44]), 0), "[65 'A', 66 'B', 67 'C', 68 'D']");	// No terminator
		// Unknown struct: raw bytes
		assert.equal(fmt.format({kind: 'struct', tag: 'nope'}, new Uint8Array([1, 2]), 0), '[]');
	});

	test('type names and expandability', () => {
		assert.equal(fmt.typeName(int(1, false, true)), 'unsigned char');
		assert.equal(fmt.typeName(int(2, true)), 'int');
		assert.equal(fmt.typeName(int(4, false)), 'unsigned long');
		assert.equal(fmt.typeName({kind: 'pointer', target: {kind: 'struct', tag: 'point'}}), 'struct point*');
		assert.equal(fmt.typeName(lbls.cSymbols.resolveStatic('points')!.type), 'struct point[3]');
		assert.equal(fmt.typeName({kind: 'struct', tag: 'u16'}), 'union u16');
		assert.equal(fmt.typeName({kind: 'float', size: 4}), 'float');
		assert.ok(fmt.isExpandable({kind: 'struct', tag: 'point'}));
		assert.ok(fmt.isExpandable({kind: 'array', length: 2, size: 2, elem: int(1, true)}));
		assert.ok(fmt.isExpandable({kind: 'pointer', target: int(2, true)}));
		assert.ok(!fmt.isExpandable({kind: 'pointer', target: {kind: 'void'}}));
		assert.ok(!fmt.isExpandable(int(2, true)));
	});

	test('locals: stack address and register names', () => {
		const v = (storage: any) => ({cName: 'x', type: int(2, true), size: 2, storage, module: 'm', level: 1, block: 0});
		assert.deepEqual(stackSource(v({kind: 'stack', offset: 4}), {base: 0xBF10}), {addr64k: 0xBF14});
		assert.deepEqual(stackSource(v({kind: 'stack', offset: -17}), {base: 0xBF10}), {addr64k: 0xBEFF});
		assert.deepEqual(stackSource(v({kind: 'stack', offset: 4}), {base: 0xFFFE}), {addr64k: 0x0002});	// Wraps
		assert.deepEqual(stackSource(v({kind: 'stack', offset: 4}), {error: '<frame not found>'}), {error: '<frame not found>'});
		assert.deepEqual(stackSource(v({kind: 'stack', offset: 4}), undefined), {error: '<frame not found>'});
		assert.deepEqual(stackSource(v({kind: 'register', registers: ['e', 'd']}), {base: 0xBF10}), {error: '<not on the stack>'});
		assert.equal(registerName(['e', 'd']), 'DE');
		assert.equal(registerName(['c', 'b', 'e', 'd']), 'DEBC');
		assert.equal(registerName(['l']), 'L');
	});

		test('encode (set value)', () => {
		assert.deepEqual([...fmt.encode(int(2, true), -2)!], [0xFE, 0xFF]);
		assert.deepEqual([...fmt.encode(int(1, false), 0x41)!], [0x41]);
		assert.deepEqual([...fmt.encode(int(4, true), 123456)!], [0x40, 0xE2, 0x01, 0x00]);
		assert.deepEqual([...fmt.encode({kind: 'pointer', target: {kind: 'void'}}, 0x9277)!], [0x77, 0x92]);
		assert.deepEqual([...fmt.encode({kind: 'float', size: 4}, 1.5)!], [0x00, 0x00, 0xC0, 0x3F]);
		assert.equal(fmt.encode({kind: 'struct', tag: 'point'}, 1), undefined);
	});
});


suite('C names in expressions', () => {
	const dir = 'tests/data/labels/projects/z88dk/c_vars_v2';

	setup(() => {
		(WorkspacePaths as any).rootPath = undefined;
		Labels.cNamesEnabled = true;
		Labels.readListFiles({
			z88dkv2: [{path: './' + dir + '/*.lis', mapFile: './' + dir + '/probe.map', srcDirs: [dir], excludeFiles: []}]
		} as any, new MemoryModelZxNext());
	});

	teardown(() => {
		Labels.cNamesEnabled = true;
		Labels.readListFiles({} as any, new MemoryModelZxNext());	// Clear
	});

	test('globals by C name, labels unchanged', () => {
		assert.equal(Expressions.evalExpression('global_counter', false), 0x9294);
		assert.equal(Expressions.evalExpression('player+2', false), 0x9282);
		assert.equal(Expressions.evalExpression('::player'.substring(2), false), 0x9280);
		// The linker name is still a label
		assert.equal(Expressions.evalExpression('_player', false), 0x9280);
	});

	test('fallback "name" -> "_name" for C module symbols', () => {
		// "main" is a function, not a variable: found through the fallback
		assert.equal(Expressions.evalExpression('main', false), 0x903C);
		// "errno" is "_errno" of an assembler module: not found
		assert.throws(() => Expressions.evalExpression('errno', false));
		// File statics need a C context (no remote here)
		assert.throws(() => Expressions.evalExpression('file_static', false));
	});

	test('disabled', () => {
		Labels.cNamesEnabled = false;
		assert.throws(() => Expressions.evalExpression('global_counter', false));
		assert.throws(() => Expressions.evalExpression('main', false));
		assert.equal(Expressions.evalExpression('_global_counter', false), 0x9294);
	});

	test('display names', () => {
		assert.equal(Labels.getDisplayName('_sum_points'), 'sum_points');
		assert.equal(Labels.getDisplayName('_sum_points', false), '_sum_points');
		assert.equal(Labels.getDisplayName('_errno'), '_errno');
		Labels.cNamesEnabled = false;
		assert.equal(Labels.getDisplayName('_sum_points'), '_sum_points');
	});
});


suite('C frame bases', () => {
	const dir = 'tests/data/labels/projects/z88dk/c_vars_v2';
	const page = (p: number, addr64k: number) => addr64k + ((p + 1) << 16);
	let lbls: LabelsClass;
	let mem: Uint8Array;
	let regs: {[name: string]: number};
	let pagedIn: boolean;
	const access: CFrameAccess = {
		read: async (addr, size) => mem.slice(addr, addr + size),
		getRegister: (name) => regs[name.toUpperCase()],
		isPagedIn: () => pagedIn
	};
	const poke = (addr: number, ...bytes: number[]) => mem.set(bytes, addr);
	const pokeWord = (addr: number, value: number) => poke(addr, value & 0xFF, value >>> 8);

	setup(() => {
		lbls = new LabelsClass();
		(WorkspacePaths as any).rootPath = undefined;
		lbls.readListFiles({
			z88dkv2: [{path: './' + dir + '/*.lis', mapFile: './' + dir + '/probe.map', srcDirs: [dir], excludeFiles: []}]
		} as any, new MemoryModelZxNext());
		mem = new Uint8Array(0x10000);
		pagedIn = true;
		// ___sdcc_enter_ix at 0x8000: pop hl / push ix / ld ix,0 / add ix,sp / jp (hl)
		poke(0x8000, 0xE1, 0xDD, 0xE5, 0xDD, 0x21, 0x00, 0x00, 0xDD, 0x39, 0xE9);
		// leaf ($8F78) and sum_points ($8F85): call ___sdcc_enter_ix
		poke(0x8F78, 0xCD, 0x00, 0x80);
		poke(0x8F85, 0xCD, 0x00, 0x80);
		// leaf's epilogue: pop ix / ret at $8F82
		poke(0x8F82, 0xDD, 0xE1, 0xC9);
		// main ($903C): ld hl,1 (no frame)
		poke(0x903C, 0x21, 0x01, 0x00);
		// The chain: leaf's frame at BF10 -> sum_points' frame at BF30
		regs = {SP: 0xBF00, IX: 0xBF10, IY: 0x5C3A};
		pokeWord(0xBF10, 0xBF30);
		pokeWord(0xBF30, 0x1234);
	});

	// main -> sum_points -> leaf (bottom to top)
	const frames = (leafPc: number) => [{addr: page(4, 0x9040)}, {addr: page(4, 0x8F98)}, {addr: page(4, leafPc)}];

	test('prologue detection', async () => {
		const resolver = new CFrameResolver(lbls.cSymbols, 'auto');
		const c = lbls.cSymbols;
		assert.deepEqual(await resolver.getPrologue(c.functionAt(page(4, 0x8F78))!, access), {usesFrame: true, register: 'ix', kind: 'call'});
		assert.deepEqual(await resolver.getPrologue(c.functionAt(page(4, 0x903C))!, access), {usesFrame: false, register: 'ix', kind: 'inline'});
	});

	test('after the prologue: frame pointer, then the chain', async () => {
		const bases = await new CFrameResolver(lbls.cSymbols, 'auto').getFrameBases(frames(0x8F7B), access);
		assert.deepEqual(bases, [undefined, {base: 0xBF30}, {base: 0xBF10}]);
	});

	test('at the first instruction: SP-2, the frame pointer is the caller\'s', async () => {
		const bases = await new CFrameResolver(lbls.cSymbols, 'auto').getFrameBases(frames(0x8F78), access);
		assert.deepEqual(bases, [undefined, {base: 0xBF10}, {base: 0xBEFE}]);
	});

	test('at the final ret after "pop ix": SP-2', async () => {
		const bases = await new CFrameResolver(lbls.cSymbols, 'auto').getFrameBases(frames(0x8F84), access);
		assert.deepEqual(bases, [undefined, {base: 0xBF10}, {base: 0xBEFE}]);
	});

	test('inline prologue with IY (-clib=sdcc_ix)', async () => {
		poke(0x8F78, 0xFD, 0xE5, 0xFD, 0x21, 0x00, 0x00, 0xFD, 0x39);	// push iy / ld iy,0 / add iy,sp
		poke(0x8F85, 0xFD, 0xE5, 0xFD, 0x21, 0x00, 0x00, 0xFD, 0x39);
		regs.IY = 0xBF10;
		regs.IX = 0x0000;
		const resolver = new CFrameResolver(lbls.cSymbols, 'auto');
		assert.equal((await resolver.getPrologue(lbls.cSymbols.functionAt(page(4, 0x8F78))!, access)).register, 'iy');
		assert.deepEqual(await resolver.getFrameBases(frames(0x8F80), access), [undefined, {base: 0xBF30}, {base: 0xBF10}]);
		// Inside the inline prologue, after "push iy": SP points to the saved frame pointer
		assert.deepEqual((await resolver.getFrameBases(frames(0x8F7A), access))[2], {base: 0xBF00});
		// Forced register
		const forced = new CFrameResolver(lbls.cSymbols, 'ix');
		assert.equal((await forced.getPrologue(lbls.cSymbols.functionAt(page(4, 0x8F78))!, access)).register, 'ix');
	});

	test('a broken chain is reported, not guessed', async () => {
		pokeWord(0xBF10, 0x4000);	// Saved frame pointer below the current frame
		const bases = await new CFrameResolver(lbls.cSymbols, 'auto').getFrameBases(frames(0x8F7B), access);
		assert.deepEqual(bases, [undefined, {error: '<frame not found>'}, {base: 0xBF10}]);
		regs.IX = 0x8000;	// Frame pointer below SP
		const bases2 = await new CFrameResolver(lbls.cSymbols, 'auto').getFrameBases(frames(0x8F7B), access);
		assert.deepEqual(bases2, [undefined, {error: '<frame not found>'}, {error: '<frame not found>'}]);
	});

	test('code paged out: frame assumed for functions with stack variables', async () => {
		pagedIn = false;
		const resolver = new CFrameResolver(lbls.cSymbols, 'auto');
		const c = lbls.cSymbols;
		assert.equal((await resolver.getPrologue(c.functionAt(page(4, 0x8F85))!, access)).usesFrame, true);
		assert.equal((await resolver.getPrologue(c.functionAt(page(4, 0x903C))!, access)).usesFrame, false);
	});
});
