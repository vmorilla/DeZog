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

