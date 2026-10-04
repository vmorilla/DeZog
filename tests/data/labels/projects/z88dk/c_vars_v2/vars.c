#include <stdint.h>

typedef struct point { int16_t x; int16_t y; } point_t;
struct sprite { point_t pos; uint8_t frame; char name[6]; struct sprite *next; };
typedef enum { RED, GREEN = 5, BLUE } colour_t;
union u16 { uint16_t w; uint8_t b[2]; };

int global_counter;                 /* bss */
int global_init = 42;               /* data */
static uint8_t file_static = 7;     /* file scope */
const char greeting[] = "HELLO";
long big = 123456L;
float ratio = 1.5;
struct sprite player = {{10, 20}, 3, "HERO", 0};
point_t points[3];
colour_t colour = BLUE;
union u16 word;
uint8_t *ptr = &file_static;

int leaf(int a)                     /* tiny: maybe no IX frame */
{
    return a + 1;
}

int sum_points(point_t *p, uint8_t count)
{
    int total = 0;
    uint8_t i;
    for (i = 0; i < count; i++) {
        int dx = p[i].x;
        total += dx;
        {
            int total = p[i].y;     /* shadowing at deeper level */
            global_counter += total;
        }
    }
    return total;
}

int with_static(void)
{
    static int calls;
    char buf[4];
    buf[0] = 'A'; buf[1] = 0;
    calls++;
    return calls + buf[0];
}

long longs(long a, long b)
{
    long r = a * b;
    struct sprite local_sprite = player;
    local_sprite.frame++;
    return r + local_sprite.frame;
}

int main(void)
{
    int result;
    points[0].x = 1; points[1].x = 2;
    result = sum_points(points, 2);
    result += with_static();
    result += leaf(result);
    big = longs(big, 3);
    word.w = result;
    return result;
}
