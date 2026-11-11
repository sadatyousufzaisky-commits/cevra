#include <winsock2.h>
#include <ws2tcpip.h>
#include "../src/extensions/host-lab/protocol.h"
#include <stdlib.h>

static int can_open_file(const char *name, DWORD access) {
    wchar_t filename[4096];
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, name, -1, filename, 4096)) return 0;
    HANDLE file = CreateFileW(filename, access, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (file == INVALID_HANDLE_VALUE) return 0;
    CloseHandle(file);
    return 1;
}

static int can_connect(const char *address, uint16_t port) {
    WSADATA info;
    if (WSAStartup(MAKEWORD(2, 2), &info)) return 0;
    SOCKET connection = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    int connected = 0;
    if (connection != INVALID_SOCKET) {
        struct sockaddr_in peer = {0};
        peer.sin_family = AF_INET;
        peer.sin_port = htons(port);
        u_long nonblocking = 1;
        if (inet_pton(AF_INET, address, &peer.sin_addr) == 1 && !ioctlsocket(connection, FIONBIO, &nonblocking)) {
            if (connect(connection, (struct sockaddr *)&peer, sizeof(peer)) == 0) connected = 1;
            else if (WSAGetLastError() == WSAEWOULDBLOCK) {
                fd_set writable;
                FD_ZERO(&writable);
                FD_SET(connection, &writable);
                struct timeval limit = {0, 500000};
                int result = 1;
                int length = sizeof(result);
                connected = select(0, NULL, &writable, NULL, &limit) > 0 &&
                    !getsockopt(connection, SOL_SOCKET, SO_ERROR, (char *)&result, &length) && !result;
            }
        }
        closesocket(connection);
    }
    WSACleanup();
    return connected;
}

static int can_create_process(void) {
    wchar_t executable[MAX_PATH];
    UINT size = GetSystemDirectoryW(executable, MAX_PATH);
    if (!size || size > MAX_PATH - 9) return 0;
    memcpy(executable + size, L"\\cmd.exe", sizeof(L"\\cmd.exe"));
    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION process;
    startup.cb = sizeof(startup);
    if (!CreateProcessW(executable, NULL, NULL, NULL, FALSE, CREATE_SUSPENDED | CREATE_NO_WINDOW,
        NULL, NULL, &startup, &process)) return 0;
    TerminateProcess(process.hProcess, 1);
    WaitForSingleObject(process.hProcess, 1000);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return 1;
}

static int can_read_clipboard(void) {
    HMODULE library = LoadLibraryExW(L"user32.dll", NULL, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!library) return 0;
    BOOL (WINAPI *open)(HWND) = (void *)GetProcAddress(library, "OpenClipboard");
    BOOL (WINAPI *close)(void) = (void *)GetProcAddress(library, "CloseClipboard");
    HANDLE (WINAPI *read_data)(UINT) = (void *)GetProcAddress(library, "GetClipboardData");
    int allowed = 0;
    if (open && close && read_data && open(NULL)) {
        allowed = read_data(CF_UNICODETEXT) != NULL;
        close();
    }
    FreeLibrary(library);
    return allowed;
}

static uint32_t probe(char *input, int isolated) {
    char *items[7];
    items[0] = input;
    for (size_t i = 1; i < 7; i++) {
        char *newline = strchr(items[i - 1], '\n');
        if (!newline) return UINT32_MAX;
        *newline = 0;
        items[i] = newline + 1;
    }
    uint32_t outcome = 0;
    if (can_open_file(items[0], GENERIC_READ)) outcome |= 1;
    if (can_open_file(items[1], GENERIC_READ)) outcome |= 2;
    if (can_open_file(items[0], GENERIC_WRITE) || can_open_file(items[1], GENERIC_WRITE)) outcome |= 512;
    if (GetEnvironmentVariableA("CEVRA_G3_SENTINEL", NULL, 0)) outcome |= 4;
    if (can_connect("127.0.0.1", (uint16_t)strtoul(items[2], NULL, 10))) outcome |= 8;
    if (can_connect(items[3], (uint16_t)strtoul(items[4], NULL, 10))) outcome |= 16;
    if (can_create_process()) outcome |= 32;
    HANDLE owner = OpenProcess(PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_CREATE_PROCESS, FALSE,
        strtoul(items[5], NULL, 10));
    if (owner) { outcome |= 64; CloseHandle(owner); }
    if (!strcmp(items[6], "clipboard-fixture") && can_read_clipboard()) outcome |= 128;
    if (isolated) {
        JOBOBJECT_BASIC_UI_RESTRICTIONS limits;
        if (!QueryInformationJobObject(NULL, JobObjectBasicUIRestrictions, &limits, sizeof(limits), NULL) ||
            (limits.UIRestrictionsClass & JOB_OBJECT_UILIMIT_ALL) != JOB_OBJECT_UILIMIT_ALL) outcome |= 256;
    }
    return outcome;
}

int main(int argc, char **argv) {
    uint8_t request[4097];
    uint32_t size;
    int isolated = argc == 2 && !strcmp(argv[1], "--isolated");
    if (!begin_frames() || read_frame(request, &size, sizeof(request) - 1) != 1) return 2;
    request[size] = 0;
    if (request[0] == 4) Sleep(INFINITE);
    if (request[0] == 5) return 7;
    if (request[0] == 6) {
        uint8_t invalid[4] = {255, 255, 255, 255};
        return !(fwrite(invalid, 1, sizeof(invalid), stdout) == sizeof(invalid) && fflush(stdout) == 0);
    }
    if (request[0] == 7) {
        if (!send_word(PROBE_RESULT, 0)) return 2;
        Sleep(INFINITE);
    }
    if (request[0] == 8) {
        char block[1024];
        memset(block, 'Q', sizeof(block));
        for (unsigned i = 0; i < 12; i++) {
            if (fwrite(block, 1, sizeof(block), stderr) != sizeof(block) || fflush(stderr) != 0) return 2;
        }
        Sleep(INFINITE);
    }
    return request[0] == PROBE ? !send_word(PROBE_RESULT, probe((char *)request + 1, isolated)) : 2;
}
