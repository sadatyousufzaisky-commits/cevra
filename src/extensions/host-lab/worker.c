#include "protocol.h"
#include <wasmtime.h>

static uint8_t rpc_response[1024 * 1024 + 1];

static wasm_trap_t *request_broker(void *env, wasmtime_caller_t *caller, const wasmtime_val_t *args,
                                 size_t nargs, wasmtime_val_t *results, size_t nresults) {
    (void)nargs;
    (void)nresults;
    unsigned *calls = env;
    wasmtime_context_t *context = wasmtime_caller_context(caller);
    wasmtime_extern_t memory;
    if (++*calls > 64 || !wasmtime_caller_export_get(caller, "memory", 6, &memory))
        return wasmtime_trap_new("broker-quota", 12);
    if (memory.kind != WASMTIME_EXTERN_MEMORY) {
        wasmtime_extern_delete(&memory);
        return wasmtime_trap_new("broker-memory", 13);
    }
    uint32_t input = (uint32_t)args[0].of.i32, length = (uint32_t)args[1].of.i32;
    uint32_t output = (uint32_t)args[2].of.i32, capacity = (uint32_t)args[3].of.i32;
    size_t available = wasmtime_memory_data_size(context, &memory.of.memory);
    uint8_t *data = wasmtime_memory_data(context, &memory.of.memory);
    int valid = length && length < MAX_REQUEST && capacity <= 1024 * 1024 &&
        input <= available && length <= available - input && output <= available && capacity <= available - output;
    uint32_t size = 0;
    if (valid) valid = send_frame(RPC_REQUEST, data + input, length) &&
        read_frame(rpc_response, &size, sizeof(rpc_response)) == 1 &&
        rpc_response[0] == RPC_REPLY && size > 1 && size - 1 <= capacity;
    if (valid) memcpy(data + output, rpc_response + 1, size - 1);
    wasmtime_extern_delete(&memory);
    if (!valid) return wasmtime_trap_new("broker-protocol", 15);
    results[0].kind = WASMTIME_I32;
    results[0].of.i32 = (int32_t)(size - 1);
    return NULL;
}

static const char *run_module(const uint8_t *bytes, size_t size, uint32_t *result, int broker) {
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
    int allowed = broker && import_count <= 1;
    if (allowed && import_count) {
        const wasm_name_t *module_name = wasm_importtype_module(imports.data[0]);
        const wasm_name_t *field_name = wasm_importtype_name(imports.data[0]);
        allowed = module_name->size == 5 && !memcmp(module_name->data, "cevra", 5) &&
            field_name->size == 7 && !memcmp(field_name->data, "request", 7);
    }
    wasm_importtype_vec_delete(&imports);
    if (import_count && !allowed) {
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
    unsigned calls = 0;
    wasmtime_extern_t imported;
    imported.kind = WASMTIME_EXTERN_FUNC;
    if (broker && import_count) {
        wasm_valtype_t *parameters[4] = { wasm_valtype_new_i32(), wasm_valtype_new_i32(), wasm_valtype_new_i32(), wasm_valtype_new_i32() };
        wasm_valtype_t *returns[1] = { wasm_valtype_new_i32() };
        wasm_valtype_vec_t parameter_types, return_types;
        wasm_valtype_vec_new(&parameter_types, 4, parameters);
        wasm_valtype_vec_new(&return_types, 1, returns);
        wasm_functype_t *type = wasm_functype_new(&parameter_types, &return_types);
        wasmtime_func_new(context, type, request_broker, &calls, NULL, &imported.of.func);
        wasm_functype_delete(type);
    }
    error = wasmtime_instance_new(context, module, import_count ? &imported : NULL, import_count, &instance, &trap);
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
    if (!failure && broker) {
        uint8_t command[5];
        if (!send_word(RESULT, *result)) { failure = "quota-or-trap"; goto cleanup; }
        uint32_t count;
        int status;
        while ((status = read_frame(command, &count, sizeof(command))) == 1) {
            if (command[0] == PING && count == 1) {
                if (!send_frame(PONG, NULL, 0)) { failure = "quota-or-trap"; break; }
                continue;
            }
            failure = "invalid-entry";
            if (command[0] != COMMAND || count != 5 ||
                !wasmtime_instance_export_get(context, &instance, "command", 7, &entry)) break;
            if (entry.kind != WASMTIME_EXTERN_FUNC) { wasmtime_extern_delete(&entry); break; }
            calls = 0;
            error = wasmtime_context_set_fuel(context, 1000000);
            if (error) { wasmtime_extern_delete(&entry); break; }
            wasmtime_val_t argument = { .kind = WASMTIME_I32, .of.i32 = (int32_t)decode_word(command + 1) };
            wasmtime_val_t value;
            error = wasmtime_func_call(context, &entry.of.func, &argument, 1, &value, 1, &trap);
            wasmtime_extern_delete(&entry);
            if (error || trap || value.kind != WASMTIME_I32 || !send_word(RESULT, (uint32_t)value.of.i32)) break;
            failure = NULL;
        }
        if (status < 0) failure = "quota-or-trap";
    }

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
        if ((request[0] != RUN && request[0] != ACTIVATE) || size < 2) return 2;
        uint32_t value;
        int broker = request[0] == ACTIVATE;
        const char *error = run_module(request + 1, size - 1, &value, broker);
        if (error) return !send_frame(REJECTED, error, (uint32_t)strlen(error));
        if (broker) return 0;
        return !send_word(RESULT, value);
    }
    return status < 0 ? 2 : 0;
}
