import {CType} from '../labels/z88dkcdb';
import {CSymbolTable} from '../labels/csymboltable';


/**
 * C expressions for the WATCH pane and hovering (design/c-variables.md,
 * section 7): access paths over C variables and simple integer arithmetic.
 *
 *   expression := additive
 *   additive   := multiplicative (('+' | '-') multiplicative)*
 *   multiplicative := unary (('*' | '/' | '%') unary)*
 *   unary      := ('*' | '&' | '-' | '+') unary | postfix
 *   postfix    := primary ('.' name | '->' name | '[' expression ']')*
 *   primary    := name | '::' name | number | '(' expression ')'
 *
 * Names are C variables (resolved by the context: locals, statics, globals),
 * numbers are decimal or hex (0x..). Variables have value semantics:
 * "points[i]" uses the value of i. Pointer arithmetic is scaled by the size
 * of the pointed-to type. No casts, no function calls, no floats in arithmetic.
 */


/** The syntax tree. */
export type CExprNode =
	{kind: 'name', name: string} |
	{kind: 'number', value: number} |
	{kind: 'member', object: CExprNode, member: string, arrow: boolean} |
	{kind: 'index', object: CExprNode, index: CExprNode} |
	{kind: 'unary', op: '*' | '&' | '-' | '+', operand: CExprNode} |
	{kind: 'binary', op: '+' | '-' | '*' | '/' | '%', left: CExprNode, right: CExprNode};


/** Where the result of an expression is. */
export type CPlace =
	{kind: 'memory', addr64k: number, type: CType, module: string} |
	{kind: 'register', registers: string[], type: CType, module: string} |	// Least significant first
	{kind: 'value', bytes: Uint8Array, type: CType, module: string};	// A computed value (no address)


/** Thrown for a name that is not a C variable: the expression is then
 * evaluated as label expression instead. */
export class CExprUnknownName extends Error {
	constructor(public readonly name: string) {
		super("'" + name + "' is not a C variable");
	}
}


/** What the evaluation needs. */
export interface CExprContext {
	/// Resolves a C variable. Undefined if the name is not a C variable.
	/// Throws if the variable exists but its value is not available (e.g. "<frame not found>").
	resolve(name: string): Promise<CPlace | undefined>;
	/// Reads memory (64k address).
	read(addr64k: number, size: number): Promise<Uint8Array>;
	/// Returns a register value, e.g. 'E'.
	getRegister(name: string): number;
	/// The types.
	table: CSymbolTable;
}


// ---- Parsing ----

type Token = {kind: 'name' | 'number' | 'op', text: string};

function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	const re = /\s*(?:(0[xX][0-9a-fA-F]+|\d+)|([A-Za-z_]\w*)|(->|::|[.[\]()*&+\-/%]))/y;
	let pos = 0;
	while (pos < text.length) {
		if (/^\s*$/.test(text.substring(pos)))
			break;
		re.lastIndex = pos;
		const m = re.exec(text);
		if (!m)
			throw Error("Unexpected '" + text.substring(pos).trim()[0] + "'");
		if (m[1] !== undefined)
			tokens.push({kind: 'number', text: m[1]});
		else if (m[2] !== undefined)
			tokens.push({kind: 'name', text: m[2]});
		else
			tokens.push({kind: 'op', text: m[3]});
		pos = re.lastIndex;
	}
	return tokens;
}


/** Parses a C expression.
 * @throws Error on a syntax error.
 */
export function parseCExpression(text: string): CExprNode {
	const tokens = tokenize(text);
	let i = 0;
	const peek = () => tokens[i];
	const isOp = (op: string) => tokens[i]?.kind === 'op' && tokens[i].text === op;
	const expectName = (): string => {
		const t = tokens[i++];
		if (t?.kind !== 'name')
			throw Error("Name expected");
		return t.text;
	};
	const expect = (op: string) => {
		if (!isOp(op))
			throw Error("'" + op + "' expected");
		i++;
	};

	const primary = (): CExprNode => {
		const t = peek();
		if (!t)
			throw Error("Unexpected end");
		if (t.kind === 'number') {
			i++;
			return {kind: 'number', value: parseInt(t.text)};
		}
		if (t.kind === 'name') {
			i++;
			return {kind: 'name', name: t.text};
		}
		if (isOp('::')) {
			i++;
			return {kind: 'name', name: '::' + expectName()};
		}
		if (isOp('(')) {
			i++;
			const e = additive();
			expect(')');
			return e;
		}
		throw Error("Unexpected '" + t.text + "'");
	};
	const postfix = (): CExprNode => {
		let node = primary();
		for (;;) {
			if (isOp('.') || isOp('->')) {
				const arrow = tokens[i++].text === '->';
				node = {kind: 'member', object: node, member: expectName(), arrow};
			}
			else if (isOp('[')) {
				i++;
				const index = additive();
				expect(']');
				node = {kind: 'index', object: node, index};
			}
			else {
				return node;
			}
		}
	};
	const unary = (): CExprNode => {
		for (const op of ['*', '&', '-', '+'] as const) {
			if (isOp(op)) {
				i++;
				return {kind: 'unary', op, operand: unary()};
			}
		}
		return postfix();
	};
	const multiplicative = (): CExprNode => {
		let node = unary();
		while (isOp('*') || isOp('/') || isOp('%')) {
			const op = tokens[i++].text as '*' | '/' | '%';
			node = {kind: 'binary', op, left: node, right: unary()};
		}
		return node;
	};
	function additive(): CExprNode {
		let node = multiplicative();
		while (isOp('+') || isOp('-')) {
			const op = tokens[i++].text as '+' | '-';
			node = {kind: 'binary', op, left: node, right: multiplicative()};
		}
		return node;
	}

	const tree = additive();
	if (i < tokens.length)
		throw Error("Unexpected '" + tokens[i].text + "'");
	return tree;
}


/** The names (C variables) used in an expression. */
export function namesInCExpression(node: CExprNode): string[] {
	switch (node.kind) {
		case 'name': return [node.name];
		case 'number': return [];
		case 'member': return namesInCExpression(node.object);
		case 'index': return [...namesInCExpression(node.object), ...namesInCExpression(node.index)];
		case 'unary': return namesInCExpression(node.operand);
		case 'binary': return [...namesInCExpression(node.left), ...namesInCExpression(node.right)];
	}
}


// ---- Evaluation ----

const INT: CType = {kind: 'int', size: 2, signed: true, isChar: false};

/** Encodes an integer (two's complement, little endian). */
function encodeInt(value: number, size: number): Uint8Array {
	const bytes = new Uint8Array(size);
	let v = BigInt(Math.trunc(value));
	if (v < 0n)
		v += 1n << BigInt(8 * size);
	for (let k = 0; k < size; k++) {
		bytes[k] = Number(v & 0xFFn);
		v >>= 8n;
	}
	return bytes;
}


/** The bytes of a place (its whole type). */
async function placeBytes(place: CPlace, ctx: CExprContext): Promise<Uint8Array> {
	const size = Math.max(ctx.table.sizeOf(place.type, place.module), 1);
	switch (place.kind) {
		case 'value': return place.bytes;
		case 'register': return new Uint8Array(place.registers.map(r => ctx.getRegister(r) & 0xFF));
		case 'memory': return ctx.read(place.addr64k, Math.min(size, 0x10000 - place.addr64k));
	}
}


/** The numeric value of a scalar place (int, char, bool, pointer, bitfield). */
async function toNumber(place: CPlace, ctx: CExprContext): Promise<number> {
	const type = place.type;
	if (type.kind === 'array' && place.kind === 'memory')
		return place.addr64k;	// Decays to a pointer
	const bytes = await placeBytes(place, ctx);
	const unsigned = (size: number) => {
		let v = 0;
		for (let k = size - 1; k >= 0; k--)
			v = v * 256 + (bytes[k] ?? 0);
		return v;
	};
	switch (type.kind) {
		case 'int': {
			const size = Math.min(type.size, 6);
			let v = unsigned(size);
			if (type.signed && (bytes[type.size - 1] & 0x80))
				v -= 2 ** (8 * size);
			return v;
		}
		case 'pointer':
			return unsigned(2);
		case 'bitfield': {
			const byteCount = Math.ceil((type.bitOffset + type.bitWidth) / 8);
			let v = Math.floor(unsigned(byteCount) / 2 ** type.bitOffset) % 2 ** type.bitWidth;
			if (type.signed && v >= 2 ** (type.bitWidth - 1))
				v -= 2 ** type.bitWidth;
			return v;
		}
	}
	throw Error("Not a number: " + type.kind);
}


/** The pointer target type of a pointer or array (decayed). */
function pointee(place: CPlace): CType | undefined {
	if (place.type.kind === 'pointer')
		return place.type.target;
	if (place.type.kind === 'array' && place.kind === 'memory')
		return place.type.elem;
	return undefined;
}


/** The place a pointer value points to. */
function target(addr: number, type: CType, module: string): CPlace {
	return {kind: 'memory', addr64k: addr & 0xFFFF, type, module};
}


/** Evaluates an expression.
 * @throws CExprUnknownName for a name that is not a C variable, Error otherwise.
 */
export async function evaluateCExpression(node: CExprNode, ctx: CExprContext, module = ''): Promise<CPlace> {
	const table = ctx.table;
	switch (node.kind) {
		case 'name': {
			const place = await ctx.resolve(node.name);
			if (!place)
				throw new CExprUnknownName(node.name);
			return place;
		}
		case 'number': {
			const size = (node.value >= -0x8000 && node.value <= 0xFFFF) ? 2 : 4;
			return {kind: 'value', bytes: encodeInt(node.value, size), type: {kind: 'int', size, signed: true, isChar: false}, module};
		}
		case 'member': {
			let object = await evaluateCExpression(node.object, ctx, module);
			if (node.arrow) {
				const t = pointee(object);
				if (!t)
					throw Error("'->' needs a pointer");
				object = target(await toNumber(object, ctx), t, object.module);
			}
			if (object.type.kind !== 'struct')
				throw Error("'" + node.member + "': not a struct or union");
			if (object.kind !== 'memory')
				throw Error("'" + node.member + "': the struct has no address");
			const struct = table.getStruct(object.type.tag, object.module);
			const member = struct?.members.find(m => m.name === node.member);
			if (!member)
				throw Error("No member '" + node.member + "' in '" + object.type.tag + "'");
			return {kind: 'memory', addr64k: (object.addr64k + member.offset) & 0xFFFF, type: member.type, module: object.module};
		}
		case 'index': {
			const object = await evaluateCExpression(node.object, ctx, module);
			const index = await toNumber(await evaluateCExpression(node.index, ctx, module), ctx);
			const t = pointee(object);
			if (!t)
				throw Error("'[]' needs an array or a pointer");
			const base = await toNumber(object, ctx);
			return target(base + index * table.sizeOf(t, object.module), t, object.module);
		}
		case 'unary': {
			const operand = await evaluateCExpression(node.operand, ctx, module);
			switch (node.op) {
				case '*': {
					const t = pointee(operand);
					if (!t)
						throw Error("'*' needs a pointer");
					return target(await toNumber(operand, ctx), t, operand.module);
				}
				case '&': {
					if (operand.kind !== 'memory')
						throw Error("'&': " + (operand.kind === 'register' ? 'held in a register' : 'not a variable'));
					return {kind: 'value', bytes: encodeInt(operand.addr64k, 2), type: {kind: 'pointer', target: operand.type}, module: operand.module};
				}
				case '-': {
					const v = -(await toNumber(operand, ctx));
					return {kind: 'value', bytes: encodeInt(v, 2), type: INT, module: operand.module};
				}
				case '+':
					return operand;
			}
			break;
		}
		case 'binary': {
			const left = await evaluateCExpression(node.left, ctx, module);
			const right = await evaluateCExpression(node.right, ctx, module);
			const lp = pointee(left);
			const rp = pointee(right);
			// Pointer arithmetic: pointer +/- integer, integer + pointer
			if ((lp || rp) && (node.op === '+' || node.op === '-')) {
				if (lp && rp)
					throw Error("Pointer arithmetic with two pointers is not supported");
				if (rp && node.op === '-')
					throw Error("Integer minus pointer");
				const [ptr, t, n] = lp ? [left, lp, right] : [right, rp!, left];
				const step = (await toNumber(n, ctx)) * table.sizeOf(t, ptr.module);
				const addr = (await toNumber(ptr, ctx)) + (node.op === '+' ? step : -step);
				return {kind: 'value', bytes: encodeInt(addr & 0xFFFF, 2), type: {kind: 'pointer', target: t}, module: ptr.module};
			}
			if (lp || rp)
				throw Error("'" + node.op + "' with a pointer");
			const a = await toNumber(left, ctx);
			const b = await toNumber(right, ctx);
			let v: number;
			switch (node.op) {
				case '+': v = a + b; break;
				case '-': v = a - b; break;
				case '*': v = a * b; break;
				default:
					if (b === 0)
						throw Error("Division by zero");
					v = (node.op === '/') ? Math.trunc(a / b) : a % b;
			}
			// The result type: the wider of both, at least int; unsigned only if both are
			const sizeOf = (t: CType) => (t.kind === 'int') ? t.size : 2;
			const isSigned = (t: CType) => (t.kind !== 'int') || t.signed;
			const size = Math.max(2, sizeOf(left.type), sizeOf(right.type));
			const type: CType = {kind: 'int', size, signed: isSigned(left.type) || isSigned(right.type), isChar: false};
			return {kind: 'value', bytes: encodeInt(v, size), type, module: left.module};
		}
	}
	throw Error("Unsupported expression");
}


/** The C access path at a position of a source line, for hovering: from the
 * start of the path to the end of the name under the cursor. E.g. in
 * "a = player.pos.x;" hovering "pos" gives "player.pos" and hovering "x"
 * gives "player.pos.x". A name inside an index ("points[i].x", hovering "i")
 * gives the name alone.
 * @param line The text of the line.
 * @param column The (0-based) column of the cursor.
 * @returns The range [start, end) and its text, or undefined if not on a name.
 */
export function cExpressionAt(line: string, column: number): {start: number, end: number, text: string} | undefined {
	// The name under the cursor
	const nameRe = /[A-Za-z_]\w*/g;
	let name: RegExpExecArray | null;
	while ((name = nameRe.exec(line))) {
		if (column >= name.index && column < name.index + name[0].length)
			break;
	}
	if (!name || /^\d/.test(name[0]))
		return undefined;
	const nameEnd = name.index + name[0].length;
	// The access path that contains it
	const pathRe = /(?:::)?[A-Za-z_]\w*(?:\s*(?:\.|->)\s*[A-Za-z_]\w*|\s*\[[^[\]]*\])*/g;
	let path: RegExpExecArray | null;
	while ((path = pathRe.exec(line))) {
		const start = path.index;
		const end = start + path[0].length;
		if (name.index < start || nameEnd > end)
			continue;
		// Inside an index: the name alone
		const before = line.substring(start, name.index);
		const depth = (before.match(/\[/g)?.length ?? 0) - (before.match(/]/g)?.length ?? 0);
		if (depth > 0)
			break;
		return {start, end: nameEnd, text: line.substring(start, nameEnd)};
	}
	return {start: name.index, end: nameEnd, text: name[0]};
}
