Probe for the C variable support (design/c-variables.md).

Built with the flags of the z88dk ZX Next sample project (z88dk v26256-2afaa14410-20261003):

    zcc +zxn -subtype=nex -vn -SO3 --opt-code-size -debug -m --list --c-code-in-asm \
        -clib=sdcc_iy -Cz"--clean" -startup=1 -pragma-include:zpragma.inc \
        vars.c banked.c -create-app -o probe.nex

`probe.map` is trimmed to the symbols of the modules `vars_c` and `banked_c`,
the symbols located between 0x8F00 and 0x92FF (function boundaries) and
`_errno` (a public "_" symbol of an assembler module).
