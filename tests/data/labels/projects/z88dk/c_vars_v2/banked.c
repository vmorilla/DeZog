#pragma codeseg PAGE_20_CODE
int banked_fn(int x, char c) __banked
{
    int y = x * 2;
    return y + c;
}
