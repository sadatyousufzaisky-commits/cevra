#include "protocol.h"
#include <wasmtime.h>

static const char *run_module(const uint8_t *bytes, size_t size, uint32_t *result) {
    const char *failure = "engine-unavailable";
    wasm_config_t *config = wasm_config_new();
    if (!config) return failure;
    wasmtime_config_consume_fuel_set(config, true);
    wasmtime_config_wasm_threads_set(config, false);
    wasmtime_config_wasm_component_model_set(config, false);
    wasmtime_config_parallel_compilation_set(config, false);
    wasm_engine_t *engine = wasm_engine_new_with_config(config);
    if (!engine) return failure;
    wasmtime_store_t *store = NULL;
    wasmtime_module_t *module = NULL;
    wasmtime_error_t *error = NULL;
    wasm_trap_t *trap = NULL;
    wasmtime_extern_t entry;

    failure = "invalid-module";
    error = wasmtime_module_new(engine, bytes, size, &module);
    if (error) goto cleanup;
    wasm_importtype_vec_t imports;
    wasmtime_module_imports(module, &imports);
    size_t import_count = imports.size;
    wasm_importtype_vec_delete(&imports);
    if (import_count) {
        failure = "imports-denied";
        goto cleanup;
    }

    failure = "quota-or-trap";
    store = wasmtime_store_new(engine, NULL, NULL);
    if (!store) goto cleanup;
    wasmtime_store_limiter(store, 16 * 1024 * 1024, 1024, 1, 1, 1);
    wasmtime_context_t *context = wasmtime_store_context(store);
    error = wasmtime_context_set_fuel(context, 1000000);
    if (error) goto cleanup;
    wasmtime_instance_t instance;
    error = wasmtime_instance_new(context, module, NULL, 0, &instance, &trap);
    if (error || trap) goto cleanup;
    if (!wasmtime_instance_export_get(context, &instance, "run", 3, &entry)) {
        failure = "invalid-entry";
        goto cleanup;
    }
    if (entry.kind != WASMTIME_EXTERN_FUNC) {
        wasmtime_extern_delete(&entry);
        failure = "invalid-entry";
        goto cleanup;
    }
    wasm_functype_t *signature = wasmtime_func_type(context, &entry.of.func);
    const wasm_valtype_vec_t *parameters = wasm_functype_params(signature);
    const wasm_valtype_vec_t *results = wasm_functype_results(signature);
    int valid = !parameters->size && results->size == 1 && wasm_valtype_kind(results->data[0]) == WASM_I32;
    wasm_functype_delete(signature);
    if (valid) {
        wasmtime_val_t value;
        error = wasmtime_func_call(context, &entry.of.func, NULL, 0, &value, 1, &trap);
        if (!error && !trap) {
            *result = (uint32_t)value.of.i32;
            failure = NULL;
        }
    } else failure = "invalid-entry";
    wasmtime_extern_delete(&entry);

cleanup:
    if (error) wasmtime_error_delete(error);
    if (trap) wasm_trap_delete(trap);
    if (module) wasmtime_module_delete(module);
    if (store) wasmtime_store_delete(store);
    wasm_engine_delete(engine);
    return failure;
}

int main(void) {
    static uint8_t request[MAX_REQUEST];
    if (!begin_frames()) return 1;
    uint32_t size;
    int status;
    while ((status = read_frame(request, &size, sizeof(request))) == 1) {
        if (request[0] == PING && size == 1) {
            if (!send_frame(PONG, NULL, 0)) return 1;
            continue;
        }
        if (request[0] != RUN || size < 2) return 2;
        uint32_t value;
        const char *error = run_module(request + 1, size - 1, &value);
        if (error) return !send_frame(REJECTED, error, (uint32_t)strlen(error));
        return !send_word(RESULT, value);
    }
    return status < 0 ? 2 : 0;
}
