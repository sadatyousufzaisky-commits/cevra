#ifndef CEVRA_EXTENSION_API_H
#define CEVRA_EXTENSION_API_H

#include <stdint.h>

#define CEVRA_API_VERSION "0.1"
#define CEVRA_BROKER_PROTOCOL 1
#define CEVRA_MAX_REQUEST_BYTES (256u * 1024u - 1u)
#define CEVRA_MAX_RESPONSE_BYTES (1024u * 1024u)

/* Return zero from a successful activation or command. */
__attribute__((export_name("run"))) int32_t cevra_activate(void);
__attribute__((export_name("command"))) int32_t cevra_command(int32_t handler);

/*
 * Exchange UTF-8 JSON in exported Wasm memory. The return value counts response
 * bytes without a terminating NUL. Invalid memory spans, exhausted host limits,
 * or a reply larger than capacity trap the module.
 */
__attribute__((import_module("cevra"), import_name("request")))
int32_t cevra_request(const char *input, uint32_t length, char *output, uint32_t capacity);

#endif
