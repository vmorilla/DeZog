# C variables for z88dk/sdcc programs — design proposal

Status: **proposal, for review**. Nothing here is implemented yet.
Branch: `claude/z88dk-c-variables`. It is based on `claude/z88dk-parser-v3-on-3.7.4`, which reads the `__C_LINE_` symbols of a z88dk `-debug` map file.

## 1. Goal

Today a z88dk C program can be stepped line by line in DeZog, but its variables can't be inspected as C variables. The user has to know the linker label (`_global_counter`), type `_global_counter,2` in the WATCH pane, and read locals off the raw stack.

This proposal adds:

1. **A "C Locals" scope** in the VARIABLES pane: the parameters and local variables visible at the current line of the selected call-stack frame, decoded by their C type.
2. **C names everywhere a user types or reads a name**: WATCH, hover, debug console, call stack. `global_counter`, `factorial` and `player.pos.x` work. The linker's leading underscore becomes an implementation detail (section 6).
3. **Typed values**: `char`, `int`, `long`, `float`, pointers, arrays, structs and unions, with arrays, structs and pointers expandable.

Non-goals, for now:
- Full C expression evaluation (arithmetic, casts, function calls).
- sccz80 local variables (sccz80 writes no type or local information; section 9).
- Optimised-away variables, and live ranges of register variables (sdcc doesn't record them).

## 2. What the toolchain gives us

With `-debug`, z88dk writes sdcc's CDB debug records into the map file as constant symbols. The record text is in the symbol name, with non-identifier characters escaped as `_xx` (hex):

```
__CDBINFO__S_3aLvars_2esum_5fpoints_24i_241_5f0_249_28_7b1_7dSC_3aU_29_2cB_2c1_2c_2d1 = $0001 ; const, public, , vars_c, ...
                     decodes to:  S:Lvars.sum_points$i$1_0$9({1}SC:U),B,1,-1
```

The examples below come from a probe program compiled with this project's exact flags (`+zxn -SO3 -debug -clib=sdcc_iy`, z88dk v26256, 2026-10-03). The probe's source and outputs become a test fixture (section 10).

### 2.1 Record kinds

| Record | Example (decoded) | Meaning |
|---|---|---|
| `M:` | `M:vars` | module (one per C file) |
| `F:` | `F:G$sum_points$0_0$0({2}DF,SI:S),C,0,0,0,0,0` | function `sum_points`, returns `int` |
| `S:G` | `S:G$player$0_0$0({13}STsprite:S),E,0,0` | global `struct sprite player` (13 bytes) |
| `S:F` | `S:Fvars$file_static$0_0$0({1}SC:U),E,0,0` | file-scope `static unsigned char` of module `vars` |
| `S:L` stack | `S:Lvars.sum_points$p$1_0$8({2}DG,STpoint:S),B,1,4` | local `point_t *p`, on the stack at frame offset +4 |
| `S:L` register | `S:Lvars.sum_points$total$1_0$9({2}SI:S),R,0,0,[e,d]` | local `int total`, held in DE |
| `S:L` static | `S:Lvars.with_static$calls$1_0$14({2}SI:S),E,0,0` | function-scope `static int calls` |
| `S:L` temp | `S:Lvars.longs$sloc0$0_1$0({4}SL:S),B,1,-4` | compiler spill temporary: **hidden** |
| `T:` | `T:Fvars$point[({0}S:S$x$0_0$0({2}SI:S),Z,0,0)({2}S:S$y$0_0$0({2}SI:S),Z,0,0)]` | `struct point { int x @0; int y @2; }` |

**Name suffix `$L_S$B`:** nesting level, sub-level and block number. For example, `dx$3_0$11` is level 3, block 11, and the shadowing inner `total$4_0$12` is level 4, block 12.

**Address space:**

| Code | Meaning | Where the value lives |
|---|---|---|
| `E` | static storage | at the linker symbol's address |
| `B` | stack | `onStack=1`, signed offset from the frame pointer |
| `R` | register | the register list in `[...]` |
| `C` | code | the function itself |

**Type chain** `({size}D1,D2,…,Spec:Sign)`:

- *Declarators:*
  - `DA<n>d`: array of n
  - `DG`: pointer (also `DC`/`DX`/`DD`/`DP`/`DI`, all plain 16-bit pointers on the Z80)
  - `DF`: function
- *Specifiers:*
  - `SC` char, `SI` int, `SL` long, `SF` float, `SV` void
  - `ST<name>` struct or union (layout from the `T:` record)
  - `SB<off>$<len>` bitfield
- *Sign:* `:S` signed, `:U` unsigned.

Enums are encoded as their integer type. The enumerator names aren't in the CDB.

### 2.2 What is *not* in a record, and where it comes from

| Needed | Source |
|---|---|
| Address of a global or static | The linker symbol in the same map file. See 2.3 for the naming. |
| A function's address range | The function's linker symbol (`_sum_points = $8F85`), up to the next function of the same module. The `__C_LINE_` addresses of its file confirm it. |
| Which block a line is in | The `__C_LINE_` symbols carry it: `vars.c::x::30000::11` is level 3 (×10000), block 11. |
| Frame pointer value | Runtime: register IX (section 4). |

### 2.3 Linker names (the underscore)

sdcc and sccz80 both prefix C identifiers:

| C entity | Linker symbol (probe) |
|---|---|
| global / function `player`, `sum_points` | `_player`, `_sum_points` (public) |
| file static `file_static` | `_file_static` (**local**: two modules may each have one) |
| function static `calls` in `with_static` | `_with_static_calls_10000_14` (local; level and block appended) |

The map line also names the **module** (`vars_c`), which ties a local symbol to its C file.

## 3. The C symbol table

The z88dk v2 label parser already reads the map. When the map contains `__CDBINFO__` records, it builds a `CSymbolTable` next to the assembler labels instead of mixing C names into them.

```
CSymbolTable
  modules:   name -> { file, fileStatics: Map<cName, CVar>, types: Map<tag, CStruct> }
  functions: [ { cName, linkerLabel, module, start: longAddr, end: longAddr,
                 locals: CVar[] (params + locals, with level/block),
                 statics: Map<cName, CVar>, blocks: BlockTree } ]
  globals:   Map<cName, CVar>
  CVar  = { cName, type: CType, storage: Static(longAddr) | Stack(offset) | Register(regs[]),
            level, block }
  CType = Int(size, signed) | Char(signed) | Float | Pointer(CType) | Array(CType, n)
          | Struct(tag, members[]) | Union(tag, members[]) | Bitfield(...) | Unknown(size)
```

- **Statics resolved by name:**
  - A file static is the *local* linker symbol `_<name>` of the same module.
  - A function static is the module's local symbol matching `_<func>_<name>_<level>_<block>`.
  - A record whose symbol can't be found is kept, with its value shown as `<no address>`, not dropped.
- **Banked addresses:** static addresses are DeZog long addresses, as the label parser already produces for banked code (`$14xxxx`). Banked data is read through the memory model like any other long address.
- **Block tree per function:** from the function's `__C_LINE_` entries, each block's address span is [first, last] of its lines. Block *c* is inside block *p* if its span lies within *p*'s span and its level is deeper. In the probe, `sum_points` gives 12 ⊂ 11 ⊂ 10 ⊂ 9.
- **Not recorded in the table:** compiler temporaries (`sloc*`) and external declarations from headers. A header declaration is an `S:G` record in a module that doesn't define the symbol, e.g. the 400 `S:G$fclose…` records in the sample project.

### 3.1 Which locals are visible at a PC

Given the function *f* containing the PC, and the block *b* of the PC's line:

1. Level-1 variables (parameters and the function body's top level) are visible anywhere in *f*.
2. A deeper variable is visible if its block is *b* or an ancestor of *b*.
3. Same name twice: the deepest level wins (shadowing). The shadowed one is still listed, greyed, with its level appended, e.g. `total (outer)`.

At the probe's line 33, this lists `p`, `count`, `total` (inner), `i`, `dx` and the outer `total`.

## 4. Where a stack variable is: the frame base

sdcc addresses parameters and stack locals relative to a frame pointer, and the CDB offsets are relative to it. Parameters are positive (+4 is the first one), locals negative. The prologue is either `call ___sdcc_enter_ix` or inline `push ix / ld ix,0 / add ix,sp`; the epilogue is `pop ix / ret`. In every function checked (`leaf`, the `__banked` function, the sample project's `factorial`), the code reads parameters at the recorded offsets (`ld l,(ix+4)`); even the one-line `leaf` sets up IX.

So for the selected frame, `address = frameBase + offset`, where:

| Situation | frameBase |
|---|---|
| Top frame, PC after the prologue and before the epilogue's `pop ix` | IX |
| Top frame, PC at the function's first instruction (prologue not run) or at the final `ret` (after `pop ix`) | SP − 2, because the return address is at SP and IX will be or was SP − 2 |
| Outer frames | Walk the IX chain: the saved caller IX is at `(IX+0)` and the return address at `(IX+2)`. Each C frame on DeZog's call stack consumes one link; assembler frames consume none. A link is accepted only if its return address matches the frame DeZog found. Otherwise the frame's locals show `<frame not found>` rather than wrong values. |

Using the IX chain instead of DeZog's heuristic call-stack analysis matters for banked code. A `__banked` function returns through `banked_call`, whose return path isn't preceded by a `CALL`, so DeZog's heuristic may not see that frame. The IX chain doesn't depend on it.

**The frame register is configurable.** With `-clib=sdcc_ix`, z88dk swaps IX and IY when assembling, so the frame pointer is IY at runtime. The setting `"framePointer": "auto" | "ix" | "iy"` covers this. `auto` reads the prologue bytes, either the inline sequence or the first bytes of `___sdcc_enter_ix`, and checks for the `DD` (IX) or `FD` (IY) prefix.

### 4.1 Register variables

`-SO3` puts many locals in registers (`R,0,0,[e,d]`). sdcc doesn't record *where* in the function the register holds the variable. Outside that live range the register holds something else.

- **Top frame:** the value is shown from the registers, with the register named and marked as possibly stale: `total = 17  (DE, valid only while live)`.
- **Outer frames:** `<in register, unavailable>`. The callee may have reused the register.
- The setting `"registerVariables": "show" | "hide"` controls both.

## 5. Showing values

| Type | Display | Expandable |
|---|---|---|
| `char` | `65 'A'` (signed or unsigned per type) | — |
| `int`, `long` (signed / unsigned) | decimal, plus hex in the tooltip, using the existing `formatting` settings | — |
| `float` | decoded as z88dk's 4-byte float. The format depends on the math library: IEEE single for math32, so this needs confirming per `-lm` choice (section 11). | — |
| pointer `T*` | `0x9294 → 42`, the address plus the first pointee value | yes: `*p` as type T; for `char*`, a string preview up to 32 bytes |
| array `T[n]` | `int16_t[3]` | yes, chunked for large n (DAP `indexedVariables`) |
| struct / union | `{x=10, y=20}` short preview | yes, members by offset from the `T:` record |
| bitfield | the extracted field value | — |
| unknown | raw bytes | — |

The memory for one scope is read in **one batched request**: every variable's (address, size) as a block. DeZog 3.8 sends this as `CMD_READ_MEM_BLOCKS`, which the jnext PR adds. On older remotes it's split into the usual reads.

**Editing** (DAP `setVariable`, which DeZog already advertises) writes the new value into memory for memory variables. Register variables are read-only in the first version.

## 6. Making the underscore irrelevant

Users meet the prefix in four places:
- naming things: WATCH, hover, debug console, launch.json labels;
- reading names: call stack, disassembly, breakpoint and hover text;
- C locals, which have no linker symbol at all;
- shadowing between a C name and an unrelated assembler label of the same spelling.

The options:

**A. Alias every `_x` label as `x` when parsing.**
*Pro:* a few lines of code; every lookup works.
*Con:* every address gets two names, so the disassembly shows `_main`/`main` twice and reverse lookups become ambiguous. It also collides silently with real assembler labels: z88dk's libraries have asm entry points and C wrappers with related names. It does nothing for locals, statics or structs.

**B. Lookup fallback: try `x`, then `_x`.**
*Pro:* tiny, no duplicates, and an existing assembler label `x` keeps priority.
*Con:* only helps typed lookups; displays still show `_main`. It can pick a `_x` that isn't a C symbol (`__register_sp`, asm labels starting with `_`). It also does nothing for locals or statics.

**C. A C-aware resolver with its own namespace (the C symbol table, section 3).**
In a C context (the selected frame's PC is in a C function), a name resolves in C scope order:

1. locals visible at the PC
2. that function's statics
3. the module's file statics
4. C globals
5. assembler labels, unchanged, so `_main` or any asm label still works

The linker name is looked up internally; the user never types it.
*Pro:* the only option that covers locals, statics (including their mangled names), scoping and shadowing. The C name and the assembler label each mean exactly one thing.
*Con:* the most work, and it needs CDB records, so it's for sdcc `-debug` builds only.

**D. Showing C names.**
Wherever DeZog displays a label that the C symbol table knows is a C function or variable, it shows the C name: call stack `factorial`, not `_factorial`, plus breakpoint and hover text. The disassembly shows the linker name by default, because it's the assembler's view. The setting `"cSymbolNames": "c" | "linker"` controls this.

**Recommendation: C + D, with B as a fallback for builds without CDB records.** The fallback is limited to symbols whose map line places them in a C module (module name ending in `_c`, e.g. `main_c`), so it never picks up assembler-only `_x` labels. It is what sccz80 builds and sdcc builds without `-debug` get.

Escape hatches:
- A name already starting with `_` is always tried as an assembler label first, so existing watches like `_global_counter,2` keep working.
- `::name` forces the C global when a local shadows it.

## 7. User interface

- **VARIABLES pane:**
  - A new scope **"C Locals"**, first in the list, present only when the selected frame's PC is in a C function. It follows the frame selected in the CALL STACK.
  - **"C Statics"**: the function's statics and the module's file statics.
  - **"C Globals"**: the globals defined in the project's own modules (decision 2).
  - The existing Registers, Disassembly, Memory Banks and Local Stack scopes stay unchanged.
- **WATCH:**
  - An expression that parses as a C access path is evaluated as C: `name`, `name.member`, `name[3]`, `p->x`, `*p`, chained.
  - Anything else goes to today's label-expression syntax unchanged (`label,size,count`, struct sub-labels).
  - C watches are **not** cached in `constExpressionsList` (today every watch is): a local's address depends on the frame, so C watches re-resolve at every stop.
- **Hover in `.c` files:** DeZog registers an `EvaluatableExpressionProvider` for C documents that returns the whole access path under the cursor (`player.pos.x`, `p->x`), not just the word, and evaluates it as a C watch. Assembler files keep today's behaviour.
- **Debug console:** commands that take a label (`-md`, `-wpadd`, …) accept C names through the same resolver. `-md player` dumps `sizeof(player)` bytes when no size is given.
- **Call stack:** C names per section 6 D.
- **Later, optional:** inline values in C source next to the current line, using the existing `InlineValuesProvider`.

## 8. Configuration

New optional object at the launch.json top level. It applies to all `z88dkv2` entries, and every field has a default:

```jsonc
"cDebug": {
    "enabled": true,                // false: no C scopes, plain label behaviour
    "framePointer": "auto",         // "auto" | "ix" | "iy"
    "registerVariables": "show",    // "show" | "hide"
    "cSymbolNames": "c",            // "c" | "linker" (call stack etc.)
    "floatFormat": "math32"         // "math32" | "math48" | "raw"
}
```

Nothing changes for a project without `__CDBINFO__` in its map, except the underscore fallback (option B), which `"enabled": false` also turns off.

## 9. Limitations (documented, not designed around)

- **Optimised code:**
  - A variable kept only in registers is reliable only while live.
  - A variable optimised away has no record and doesn't appear.
  - At `-SO3` many small locals are register variables (6 of the probe's 16 locals and parameters).
- **sccz80:** no CDB records. Globals work by name through the fallback (address and name only; size guessed from the distance to the next label, as WATCH does today). No locals or types.
- **Interrupts:** an ISR compiled by sdcc is expected to set up an IX frame like any function (to be verified in phase 3). A frame interrupted mid-prologue can't be decoded and shows `<frame not found>`.
- **Enums:** shown as integers (no enumerator names in the CDB).
- **Banked data:** shown correctly when the bank is mapped. Otherwise it's read through the memory model's bank access, as long-address labels are today.

## 10. Implementation plan

New files:
- `src/labels/z88dkcdb.ts`: decoding (`_xx` escapes), record parsing, the type-chain grammar.
- `src/labels/csymboltable.ts`: the table, the block trees, `functionAt(longPc)`, `visibleLocals(fn, pc)`, `resolve(name, context)`.
- `src/variables/cvars.ts`: `CLocalsVar`, `CStaticsVar` and `CValueVar` (struct/array/pointer children), all `ShallowVar`s.
- `src/misc/cframes.ts`: frame base computation and the IX/IY chain walk.

Touched:
- `z88dklabelparserv2.ts`: feed `__CDBINFO__` and module data to the table.
- `debugadapter.ts`: scopes per frame, the C watch/hover path, no caching for C watches.
- `extension.ts`: the C hover provider.
- `settings.ts` and `package.json`: the `cDebug` schema.

| Phase | Scope | Done when |
|---|---|---|
| 1 | CDB decoder, symbol table, block trees, name resolution (C + D + fallback B) | Unit tests against the probe fixture. WATCH/hover/console accept `global_counter`, `player`, `file_static`, `calls`; the call stack shows `factorial`. |
| 2 | "C Locals" / "C Statics" for the **top frame**: stack variables, all types, expansion, the entry/exit frame-base rule | Correct values at every line of the probe's `sum_points`, `longs`, `banked_fn` and `with_static` under zsim and jnext |
| 3 | Outer frames (IX chain), register variables, `setVariable`, `framePointer: auto` | Selecting an outer frame shows its locals; an `-clib=sdcc_ix` build works |
| 4 | C access-path expressions in WATCH and hover (`.`, `[]`, `->`, `*`), the C hover provider | `player.pos.x`, `points[1].x`, `p->y`, `*ptr` in WATCH and hover |

**Tests:**
- **Fixture:** `tests/data/labels/projects/z88dk/c_vars_v2/`, containing the probe sources plus the `.map` and `.lis` files zcc generated (committed, as the existing z88dk fixtures are).
- **Unit tests:**
  - the record and type grammar, every kind in 2.1;
  - static name resolution, including the mangled function static;
  - block visibility and shadowing at each probe line;
  - frame base at the entry, body and exit of a function;
  - the IX chain over a synthetic stack.
- **Integration:** zsim runs the probe `.nex` to breakpoints and checks the decoded values against known ones.
- **Manual:** jnext over DZRP with this sample project.

## 11. Decisions (review of 2026-10-03)

1. **Disassembly names:** the disassembly keeps the linker name (`_factorial`); everything else shows the C name.
2. **Globals:** a **"C Globals"** scope is included, listing the globals defined in the project's own modules (not header declarations).
3. **WATCH precedence:** C wins. A plain name that resolves as C is evaluated as C. Names starting with `_` and the `label,size,count` forms stay assembler.
4. **Float format:** math32 (IEEE-754 single) by default, configurable with `"cDebug": {"floatFormat": "math32" | "math48" | "raw"}`. `math48` decodes z88dk's 48-bit format for 6-byte values; any size the chosen format can't decode is shown as raw bytes.
5. **sccz80:** the name-only fallback is enough.
6. **Upstream:** stays on this fork for now.

### Phase 1, as implemented first

Phase 1 was widened slightly so that it is useful on its own. Besides the symbol table and name resolution, it includes typed values for **static storage**: the "C Globals" and "C Statics" scopes, WATCH and hover of globals and statics, and C names in the call stack. Stack locals ("C Locals") follow in phase 2.

### Phase 2, as implemented

- **"C Locals"** for every C frame of the call stack. Stack variables use the frame base of section 4: the frame pointer (IX, or IY detected from the prologue), SP − 2 at the function's first instruction and at the final `ret`, and the saved-frame-pointer chain for outer frames. A broken chain shows `<frame not found>`.
- **Nested blocks:** a level-1 variable is visible in the whole function. A deeper one is visible from a line of its block up to the next line of a lower level (section 3.1). A shadowed variable is listed as `name (outer)`.
- **Register variables:** shown in the top frame as `value  (in DE, may be stale)`; outer frames show `<in register, unavailable>`; hidden with `"registerVariables": "hide"`. They are read-only.
- **WATCH and hover** resolve locals first, in the selected frame.
- **Checked against a running program** (jnext over DZRP, DeZog's adapter driven without VS Code):
  - the sample project's recursive `factorial`, where an outer frame is reached through `banked_call`;
  - the probe's `sum_points`, covering nested blocks and shadowing;
  - the probe's `longs`, with a struct on the stack and a `long` in DEBC.

**Follow-up (not C variables):** DeZog's call-stack analysis gets confused by `banked_call`. It shows extra frames inside the trampoline (`8EE4h`, `8EE5h`) and places the outer `factorial` frame at the function's first address, so it shows line 7 instead of the line of the recursive call. The locals are correct regardless, because the frame-pointer chain doesn't depend on it. The chain also gives each C frame's exact return address, so it could be used to rebuild the C part of the call stack.


### Phase 4, as implemented

- **C expressions in WATCH and hover** (`src/variables/cexpr.ts`):
  - access paths `a.b`, `p->b`, `a[i]`, `*p`, `&a`, `::name`;
  - integer arithmetic `+ - * / %`, with pointer arithmetic scaled by the element size;
  - parentheses.
- **Value semantics:** variables mean their values, so `points[i].y` uses the value of `i`, wherever `i` is stored (stack, register or static).
- **Fallback to label expressions:** an expression is evaluated as a label expression, unchanged, when:
  - it doesn't parse as C, or contains `,` or `;` (e.g. `label,2,10`);
  - it uses no C variable (`0x8000`);
  - it uses a name that isn't a C variable (`HL`, a label);
  - it uses a linker name (`_player`).
- **Errors:** a real error (`player.nope`, `ptr->x`, `n / 0`) is shown in WATCH and suppressed when hovering.
- **Hover in `.c` files:** an `EvaluatableExpressionProvider` returns the access path up to the hovered name (`player.pos` for `pos`, `player.pos.x` for `x`). Inside an index, it returns the name alone. In sessions of other debuggers it returns the word, as VS Code's default would.
- **Editing:** WATCH values can be set via `setExpression` (e.g. `points[1].y = 99`), but not register variables or computed values.
- **Checked live** in jnext on the probe, in `sum_points` (nested blocks, register locals) and against globals; see the session notes.

Not done: logpoint `${…}` and breakpoint conditions with C names (they still use labels, i.e. addresses), casts, `sizeof`, comparisons, and floats in arithmetic.

## 12. Plan: logpoints, assertions and the banked call stack

Status: **plan, not implemented**. Written 2026-10-04 after phase 4. The findings below were checked against the code of this branch and the sample project's build (z88dk v26256, `+zxn`, `-clib=sdcc_iy`).

| Part | What | Depends on |
|---|---|---|
| A | Groundwork: a shared C expression service, and comparisons/logic in the grammar | — |
| B | C names in logpoints (`${n}`, `${player.pos.x}`) | A |
| C | C names in breakpoint conditions and `ASSERTION`s | A |
| D | A correct call stack (and stepping) through `banked_call` | — (independent) |

**Recommended order: D, A, B, C.**
- D is a correctness problem visible in every session with banked code, and it may also cause step-over to run away (D.5).
- B is the smallest of the C-name parts, and it proves the service from A before C makes conditions asynchronous.

### 12.A Groundwork

1. **A C expression service.** Move `resolveCExpression` and its context (locals through the frame resolver, statics, globals) out of `debugadapter.ts` into `src/variables/cexprservice.ts`. It gets the call stack, a frame index, and the remote access (memory, registers, paging). WATCH and hover keep using it unchanged. Logpoints and conditions call it with a one-frame stack `[{addr: pc}]`, because they're evaluated at their own address.
2. **Grammar** (`cexpr.ts`): add, with C precedence and results 0/1:
   - comparisons `== != < > <= >=`;
   - logic `&& || !`, with `&&`/`||` short-circuiting so `p != 0 && p->x > 3` doesn't read through a null pointer;
   - bitwise `& | ^ ~ << >>` (binary `&` is told apart from unary `&` by position).
3. **One rule for "is this C?",** shared by every user: it parses as C, uses at least one name, every name is a C variable, and no name starts with `_`. Otherwise the existing label evaluation is used, unchanged, as WATCH does today.
4. **Tests:** grammar and precedence, short-circuit (no memory read past a false `&&`), the shared rule.

### 12.B C names in logpoints

**Today** (`src/misc/logeval.ts`):
- A logpoint message is prepared **once, when the logpoint is created**. `replaceLabels` turns every name into a fixed 64K address, `b@(…)`/`w@(…)` read memory when it fires, and registers give their values.
- A C local has no fixed address (it depends on the frame), so `${n}` can't work this way.
- Source logpoints in C (`// LOGPOINT [group] …`) already work through `--c-code-in-asm`.

**Design:**
1. **Pass the address to `LogEval`.** Logpoints from the source know it (`InstrumentationParser`); for VS Code logpoints it's the breakpoint's long address (`debugadapter.ts`, where `new LogEval(bp.logMessage, …)` is created). It gives the context: the function's visible locals and statics.
2. **Decide when preparing.** A `${…}` whose expression (without `:format`) is C by rule A.3 is kept as text and marked "C". Everything else is prepared as today.
3. **Evaluate when it fires.** A C segment is evaluated through the service (A.1) at the logpoint's address. The result is formatted like WATCH (`{x=10, y=20}`, `"HERO"`, `65 'A'`), or with an explicit `:format` (`hex8`, `int16`, …) applied to its numeric value.
4. **Errors** are printed in place (`n=<frame not found>`), so the rest of the message still appears.

**Tests:**
- Unit: `LogEval` with a fake remote, covering mixed C and legacy segments, formats and errors.
- Live: the harness with a logpoint `n=${n} my_var=${my_var}` on `factorial`, expecting one line per call: `n=5 … n=1`.

### 12.C C names in conditions and ASSERTIONs

**Today:**
- An `ASSERTION expr` comment becomes a breakpoint with the condition `!(expr)` (`InstrumentationParser.createAssertions`, `Expressions.getAssertionFromCondition`).
- Conditions, from assertions and from VS Code's breakpoint condition field, are evaluated **synchronously** with `Expressions.evalExpression`: labels are addresses, registers are values, and **memory can't be read**. The code says so: "If I would allow 'await evalExpression' I could also allow e.g. memory checks".
- They're evaluated in `DzrpRemote.checkConditionAndLog`, called from an asynchronous handler that already awaits the logpoint evaluation (`dzrpremote.ts`, around line 1002), and in `ZSimRemote`, inside the synchronous CPU loop.

**Design:**
1. **`checkConditionAndLog` becomes asynchronous.** A C condition (rule A.3) is evaluated through the service at the breakpoint's address. Legacy conditions are evaluated as today.
2. **DZRP remotes first** (cspect, dzrp, zxnext): their caller is already asynchronous.
3. **zsim later** (decision 2026-10-04), not in the same change: its check runs inside the CPU loop. For a breakpoint with a C condition, zsim stops, the condition is evaluated asynchronously, and execution continues automatically if it's false. Legacy conditions stay in the loop. The alternative, a synchronous evaluator over zsim's local memory, would duplicate the evaluator.
4. **Reason text** for a failed C assertion shows the values of the names, e.g. `Assertion failed: n > 0 (n = -1)`. The legacy `replaceVarsWithValues` would show addresses for C names.
5. **Source assertions in C:** `// ASSERTION n > 0` on a code line, through `--c-code-in-asm` like logpoints.

**Cost:** every hit of a C-conditioned breakpoint costs a few DZRP round trips (frame base, values). That's fine for normal use, but slow for a breakpoint hit thousands of times; the user guide should say so.

**Tests:**
- Unit: conditions, with `!(…)` wrapping and short-circuit.
- Live: a breakpoint on `factorial` with the condition `n == 2` stops once, with `n = 2`. An `// ASSERTION n > 1` stops when `n` reaches 1, with the reason text.

### 12.D The call stack through `banked_call`

**How z88dk's `banked_call` works** (`+zxn`, module `zxn_banked_call`; disassembled from the sample's NEX):

```
caller:      call banked_call          ; return address R points to the defq
             defq target               ; target address (2), bank (1), 0
             ...                       ; execution continues here: R + 4
banked_call: di
             pop  hl                   ; HL = R
             ld   (mainsp),sp
             ld   sp,(tempsp)          ; switch to the banked stack
             ld   a,(cur_bank) / push af        ; save the previous bank
             ld   e,(hl) ... a,(hl) ... hl += 4  ; DE = target, A = bank, HL = R + 4
             push hl                   ; the real return address, on the BANKED stack
             ld   (tempsp),sp / ld sp,(mainsp)  ; back to the main stack
             ld   (cur_bank),a / call page_in   ; NEXTREG $50/$51 (banking_mmu_low/high)
             ei / ex de,hl
             call l_jphl               ; jp (hl): calls the target; pushes the return
                                       ; address banked_call+$29 on the MAIN stack
             ... back on the banked stack: pop the real return address and the bank,
             push the return address on the main stack, restore the bank, ret
_initbankedsp: ld (tempsp),sp / ld hl,-100 / add hl,sp / ld sp,hl
                                       ; the banked stack = the 100 bytes below the
                                       ; initial SP; the main stack starts below it
```

**Why the call stack is wrong today** (`RemoteBase.getCallStackFromEmulator`, `getStackEntryType`):
- **No caller frame:** during a banked function, the main stack holds only `banked_call+$29`, the return address after `call l_jphl`. The caller's real return address (R + 4) is on the banked stack, so the caller's call site doesn't appear.
- **Misnamed frames:** that return address is preceded by `call l_jphl`, so DeZog creates a frame named after the called address, `8EE4h` (`l_jphl`), located inside `banked_call`. It also names a frame after `_main` with an address inside `banked_call`.
- **Garbage frames:** the stack scan runs from SP to `topOfStack` and so includes the banked stack, whose words (return addresses, saved banks, stale data) can be mistaken for return addresses (`8EE5h`).
- **Wrong line:** the outer `factorial` frame gets the function's first address, so it shows line 7 instead of line 14.
- **What's unaffected:** C locals in outer frames are correct regardless, because the IX chain doesn't depend on these frames.

**Design:**
0. **Room for other architectures** (decision 2026-10-04: ZX Next first). A banked-call convention is an interface, and z88dk's `+zxn` `banked_call` is its first implementation. A convention:
   - detects itself from the map's symbols, so each one declares the symbols it needs;
   - verifies the code at run time against its signature;
   - recognises its trampoline return addresses on the main stack;
   - reads its records of active banked calls (target, real return address, the caller's banking);
   - gives the end of the main stack, if it keeps its own stack there;
   - gives the length of its call sequence, for step over (7 bytes for `call banked_call` + `defq`).

   The call-stack and stepping code only uses the interface. Further conventions, e.g. classic `+zx` 128K banking, are added as new implementations.
1. **Detect** z88dk's `zxn` `banked_call` from the map, not from fixed addresses:
   - `banked_call`, plus the local symbols `tempsp`, `mainsp` and `cur_bank` of module `zxn_banked_call`, and `l_jphl`;
   - the constants `banking_mmu_low`/`banking_mmu_high`, which give the banked slots.

   Verify the code at `banked_call` against the signature above (`F3 E1 ED 73 … ED 7B …`), and get the trampoline return address (`banked_call+$29`) and the banked stack size (the `ld hl,-N` in `_initbankedsp`) from the code. Unknown code (another z88dk version or target) means no special handling. Other targets (classic `+zx` 128K banking) can be added as further signatures.
2. **Read the banked stack** at each stop: from `(tempsp)`, entries of 4 bytes, innermost first: the real return address, then the saved bank (pushed as AF, so A, the bank, is the upper byte). Each `banked_call+$29` value on the main stack, from SP upwards, corresponds to the next entry. No end marker is needed.
3. **Rebuild the frames:** each trampoline return becomes a frame with:
   - name: the function at the `defq` target (long address from address and bank, then the C name);
   - caller address: R − 3, the `call banked_call` instruction, as a long address with the caller's bank, which is the saved bank of the entry when the address is in a banked slot.

   No frame is created for `l_jphl` or inside `banked_call`.
4. **Limit the scan** to the main stack: below the banked stack, i.e. below (SP at `_initbankedsp`) − N. That SP is the startup code's stack pointer when it runs `_initbankedsp`, just before calling `main`. It's normally `__register_sp` (to be verified), otherwise the value `tempsp` has when no banked call is active. This also suggests recommending `topOfStack: "__register_sp"`. The sample project's launch.json has `0xFF58`, which isn't its stack top (`__register_sp = $BFF0`).
5. **Stepping, to verify first:**
   - **Step over:** `RemoteBase.calcStepBp` places the step-over breakpoint at `pc + opcode.length`, which is `pc + 3` for `call banked_call`, on the `defq` bytes that never execute. So stepping over a banked call probably runs away. Fix: treat `call banked_call` as a 7-byte instruction, as `RST $08` already gets an adjusted length for esxDOS. Let the disassembly show the 4 bytes as `defq` data.
   - **Step out:** stepping out of a banked function returns into `banked_call`. It should stop at R + 4 in the caller instead.
6. **Reverse debugging** (`cpuhistory.ts` builds its own call stack): later, with the same trampoline knowledge.

**Tests:**
- Unit: a synthetic memory image (code bytes with the signature, main stack, banked stack) for 1, 2 and 3 nested banked calls, including recursion and a non-banked caller (`main`). Unknown code must give the old behaviour.
- Live: the sample's `factorial` at the third recursion level should give `main → factorial (line 14) → factorial (line 14) → factorial`, with no `8EE4h` frames. `n` in each frame should be unchanged (5, 4, 3).
- Stepping: step over `factorial(5)` in `main` stops on the next line; step out of `factorial` stops in its caller.

### 12.D, as implemented

- **The interface and the first convention:** `src/remotes/bankedcalls.ts` holds `BankedCallConvention`, the registry `BANKED_CALL_CONVENTIONS`, and `Z88dkZxnBankedCall`.
  - The z88dk v2 parser detects a convention from the map once per map file; `Labels.bankedCalls` holds it.
  - The convention verifies `banked_call` against the signature at run time, retrying until it matches (the program may not be loaded yet). It takes the trampoline return and the banked stack size from the code.
  - Confirmed live in the sample: `tempsp` is `__register_sp` (`$BFF0`) when no banked call is active, and `$BFE4` (3 records) at the third recursion level.
- **Call stack** (`RemoteBase.getCallStackFromEmulator`):
  - The stack scan stops at the main stack's top (`__register_sp − 100`).
  - Each trampoline return becomes a frame for the called function, at its real call site, in the caller's bank.
- **The frame pointer chain** (`framePointerChain`, `cframes.ts`) was added as well; the plan didn't foresee it. Small integers on the stack can look like return addresses: the argument 3 of `factorial(n − 1)` follows a `CALL` at `$0000` in page 20. That produced a spurious frame, which also shifted the C locals.
  - Within the span of the validated IX chain, only its return address slots (IX+2) are taken as return addresses; outside it, the old heuristic applies.
  - Only used for programs with C debug information.
- **Step over** (`calcStepBp`): a `call banked_call` + `defq` counts as 7 bytes. Confirmed: before the change, stepping over `factorial(5)` in `main` ran away; now it stops on the next line.
- **Step out** (`DzrpRemote.stepOut`): a `ret` into the trampoline doesn't stop. Confirmed: before the change, stepping out of `factorial(1)` stopped inside `banked_call`; now it stops in `factorial(2)` right after the call (`$15002B`).
- **Live result** (jnext, sample, `factorial` at the third recursion level): `main` (line 14) → `factorial` → `factorial` → `factorial` (line 15), with `n` = 5, 4, 3 and no `8EE4h` frames.
- **Not done:** zsim's own step out (`ZSimRemote`), reverse debugging's call stack (`cpuhistory.ts`), the disassembly of the `defq` as data, and step into a banked call (it steps into `banked_call`).

### 12.E Decisions (2026-10-04)

1. C conditions in zsim come later (12.C.3).
2. D targets z88dk's `+zxn` `banked_call` first, behind an interface that leaves room for other architectures (12.D.0).
3. No colon form for `LOGPOINT:`/`ASSERTION:`: it was a typo; the existing syntax stays.
