#ifndef CEVRA_LAB_PROTOCOL_H
#define CEVRA_LAB_PROTOCOL_H

#include <fcntl.h>
#include <io.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <windows.h>

#define MAX_REQUEST (256u * 1024u)
#define PING 1
#define RUN 2
#define PROBE 3
#define READY 16
#define PONG 17
#define RESULT 18
#define REJECTED 19
#define PROBE_RESULT 20

static uint32_t decode_word(const uint8_t *bytes) {
    return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << 8) |
        ((uint32_t)bytes[2] << 16) | ((uint32_t)bytes[3] << 24);
}

static void encode_word(uint8_t *bytes, uint32_t value) {
    for (unsigned i = 0; i < 4; i++) bytes[i] = (uint8_t)(value >> (i * 8));
}

static int send_frame(uint8_t type, const void *data, uint32_t size) {
    uint8_t header[5];
    encode_word(header, size + 1);
    header[4] = type;
    return fwrite(header, 1, sizeof(header), stdout) == sizeof(header) &&
        (!size || fwrite(data, 1, size, stdout) == size) && fflush(stdout) == 0;
}

static int send_word(uint8_t type, uint32_t value) {
    uint8_t bytes[4];
    encode_word(bytes, value);
    return send_frame(type, bytes, sizeof(bytes));
}

static int begin_frames(void) {
    if (_setmode(_fileno(stdin), _O_BINARY) == -1 || _setmode(_fileno(stdout), _O_BINARY) == -1) return 0;
    uint8_t greeting[8];
    encode_word(greeting, 1);
    encode_word(greeting + 4, GetCurrentProcessId());
    return send_frame(READY, greeting, sizeof(greeting));
}

static int read_frame(uint8_t *buffer, uint32_t *size, uint32_t limit) {
    uint8_t header[4];
    size_t count = fread(header, 1, sizeof(header), stdin);
    if (!count && feof(stdin)) return 0;
    if (count != sizeof(header)) return -1;
    *size = decode_word(header);
    if (!*size || *size > limit || fread(buffer, 1, *size, stdin) != *size) return -1;
    return 1;
}

#endif
