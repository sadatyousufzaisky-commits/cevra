#include "cevra.h"

#define STRING_VALUE(value) #value
#define STRING_LITERAL(value) STRING_VALUE(value)

#define SAY_HELLO 0

int32_t cevra_activate(void) {
    /* A fresh Wasm instance registers once, so this activation needs one request ID. */
    static const char request[] =
        "{\"protocol\":" STRING_LITERAL(CEVRA_BROKER_PROTOCOL)
        ",\"requestId\":\"hello-1\",\"method\":\"commands.register\",\"params\":{"
        "\"id\":\"say-hello\",\"title\":\"Say hello\",\"handler\":" STRING_LITERAL(SAY_HELLO) "}}";
    /* Registration returns a short receipt or a bounded broker error. */
    char response[512];
    int32_t size = cevra_request(request, sizeof(request) - 1, response, sizeof(response));

    /* The API 0.1 broker emits these envelope fields before the result object. */
    static const char accepted[] =
        "{\"protocol\":" STRING_LITERAL(CEVRA_BROKER_PROTOCOL) ",\"requestId\":\"hello-1\",\"ok\":true,\"result\":{";
    if (size < (int32_t)(sizeof(accepted) - 1)) return 1;
    for (unsigned i = 0; i < sizeof(accepted) - 1; i++) {
        if (response[i] != accepted[i]) return 1;
    }
    return 0;
}

int32_t cevra_command(int32_t handler) {
    return handler == SAY_HELLO ? 0 : 1;
}
