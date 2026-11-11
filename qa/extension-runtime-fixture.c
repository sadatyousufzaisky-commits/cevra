#include <stdint.h>

__attribute__((import_module("cevra"), import_name("request")))
extern int32_t broker_request(const char *, int32_t, char *, int32_t);

static char response[65536];
static char message[4096];
static unsigned sequence;

static unsigned length(const char *text) {
    unsigned count = 0;
    while (text[count]) count++;
    return count;
}

static void append(char *target, const char *text) {
    unsigned offset = length(target);
    while (*text) target[offset++] = *text++;
    target[offset] = 0;
}

static int contains(const char *text, const char *needle) {
    for (unsigned index = 0; text[index]; index++) {
        unsigned match = 0;
        while (needle[match] && text[index + match] == needle[match]) match++;
        if (!needle[match]) return 1;
    }
    return 0;
}

static int request(const char *method, const char *params) {
    char number[12];
    unsigned value = ++sequence, digits = 0;
    do { number[digits++] = (char)('0' + value % 10); value /= 10; } while (value);
    message[0] = 0;
    append(message, "{\"protocol\":1,\"requestId\":\"");
    while (digits) {
        char digit[2] = { number[--digits], 0 };
        append(message, digit);
    }
    append(message, "\",\"method\":\"");
    append(message, method);
    append(message, "\",\"params\":");
    append(message, params);
    append(message, "}");
    int32_t size = broker_request(message, (int32_t)length(message), response, sizeof(response) - 1);
    if (size < 0 || (unsigned)size >= sizeof(response)) return 0;
    response[size] = 0;
    return contains(response, "\"ok\":true");
}

static int field(const char *name, char *output, unsigned capacity) {
    for (unsigned index = 0; response[index]; index++) {
        unsigned match = 0;
        while (name[match] && response[index + match] == name[match]) match++;
        if (name[match]) continue;
        const char *start = response + index + match;
        unsigned count = 0;
        while (start[count] && start[count] != '"' && count + 1 < capacity) { output[count] = start[count]; count++; }
        output[count] = 0;
        return start[count] == '"';
    }
    return 0;
}

__attribute__((export_name("run"))) int32_t run(void) {
    if (!request("commands.register", "{\"id\":\"saved-fix\",\"title\":\"Review saved answer\",\"handler\":0}")) return 1;
    if (!request("commands.register", "{\"id\":\"draft-fix\",\"title\":\"Review draft answer\",\"handler\":1}")) return 2;
    if (!request("commands.register", "{\"id\":\"check-selection\",\"title\":\"Check active selection\",\"handler\":3}")) return 3;
    return 0;
}

__attribute__((export_name("command"))) int32_t command(int32_t handler) {
    if (handler == 2) return broker_request((const char *)0x7fffffff, 100, response, sizeof(response));
    if (handler == 3) {
        if (request("editor.readSelection", "{}")) return contains(response, "\"text\":\"answer\"") ? 0 : 9;
        return contains(response, "PERMISSION_DENIED") ? 0 : 10;
    }
    if (request("workspace.readFile", "{\"path\":\"private.txt\",\"source\":\"disk\"}")) return 3;
    if (!contains(response, "PERMISSION_DENIED")) return 4;
    const char *read = handler == 1 ? "{\"path\":\"nested/value.js\",\"source\":\"draft\"}" :
        "{\"path\":\"nested/value.js\",\"source\":\"disk\"}";
    if (!request("workspace.readFile", read)) return 5;
    char handle[40], revision[65], params[1024];
    if (!field("\"fileHandle\":\"", handle, sizeof(handle)) || !field("\"revision\":\"", revision, sizeof(revision))) return 6;
    params[0] = 0;
    append(params, "{\"fileHandle\":\""); append(params, handle);
    append(params, "\",\"expectedRevision\":\""); append(params, revision);
    append(params, "\",\"items\":[{\"from\":0,\"to\":5,\"severity\":\"info\",\"message\":\"Check answer\"}]}");
    if (!request("diagnostics.publish", params)) return 7;
    params[0] = 0;
    append(params, "{\"fileHandle\":\""); append(params, handle);
    append(params, "\",\"expectedRevision\":\""); append(params, revision);
    append(params, "\",\"proposedText\":\"const answer = 42;\\n\",\"explanation\":\"Correct the answer\"}");
    return request("editor.proposeEdit", params) ? 0 : 8;
}
