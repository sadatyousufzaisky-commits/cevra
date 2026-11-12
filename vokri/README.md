# Vokri

Vokri is a Windows x64 desktop SDK written in C#. It owns the window lifecycle, UI thread dispatcher, layout, input routing, drawing, and service transport. It calls Win32 and uses Windows controls for text editing, list selection, and buttons. A Vokri application can render its interface without Electron, WebView2, WinForms, WPF, or Node.js.

## Build the SDK

Use Windows 10 or 11 x64, .NET Framework 4.8 or later, and Node.js 24 to invoke the repository build script. The SDK build uses the Windows .NET Framework compiler and produces `dist/vokri/Vokri.dll`.

```powershell
node scripts/build-vokri.cjs --sdk-only
```

Reference the DLL from a .NET Framework 4.8 x64 application and place it beside the executable. Use an STA entry point. Copy the workbench manifest and give the assembly identity your application's name. The manifest opts into per-monitor DPI awareness and Windows visual styles. [Workbench manifest](hosts/cevra/vokri.manifest), [Windows DPI changes](https://learn.microsoft.com/en-us/windows/win32/hidpi/wm-dpichanged)

```csharp
using System;
using Vokri;

internal static class Program
{
    [STAThread]
    private static int Main()
    {
        using (var app = new Application())
        {
            var window = new Window(app, "Notes", new Size(720, 460), new Size(420, 300));
            var editor = new TextEditor(new Size(480, 240));
            var copy = new Button("Copy notes", new Size(120, 32));
            copy.Clicked += () => Clipboard.WriteText(window, editor.Text);
            window.BindShortcut('L', Modifiers.Control, () => editor.Focus());
            window.SetContent(new Grid(new[] { Track.Star() }, new[] { Track.Star(), Track.Fixed(32) }, 8, 12)
                .Add(editor, 0, 0).Add(copy, 0, 1));
            window.Show();
            return app.Run();
        }
    }
}
```

Save the example as `Notes.cs` and a copy of the manifest as `Notes.manifest` at the repository root to build it with the following command.

```powershell
& "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /platform:x64 /reference:dist\vokri\Vokri.dll /win32manifest:Notes.manifest /out:dist\vokri\Notes.exe Notes.cs
& .\dist\vokri\Notes.exe
```

## Desktop APIs

| API | Behavior |
| --- | --- |
| `Application` | STA message loop, bounded UI callback queue via `Post`, and an application error event |
| `Window` | Multiple windows, optional ownership, minimum sizing, per-monitor DPI scaling, keyboard shortcuts, and cancellable close |
| `Grid` | Nested fixed, automatic, and proportional tracks with gaps, padding, and spans |
| `Label`, `Button`, `TextField`, `TextEditor`, `ListBox` | Native controls with focus, keyboard navigation, and Windows accessibility for standard control roles |
| `Canvas`, `DrawingContext` | Native paint callback for text, lines, and fills in logical coordinates, plus pointer presses |
| `Dialogs`, `Clipboard` | Native file, folder, save, and confirmation dialogs, and bounded Unicode clipboard access |
| `ServiceClient` | Asynchronous requests and notifications over private pipes with deadlines and process-tree ownership |

Build a grid before attaching it to a window. Update attached controls on the UI thread. Use `Application.Post` to schedule UI work from background callbacks. Handle a `false` result when the dispatcher has closed or its queue is full. Use the drawing context only inside its paint callback. Window and control bounds use 96-DPI logical units. Use standard controls for interactive elements that need built-in keyboard and accessibility behavior. [Windows keyboard navigation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-isdialogmessagew)

## Service protocol

Construct `ServiceClient` with an absolute executable path, an argument list, an absolute working directory, and optional environment overrides. A null override removes that variable for the service. Windows places the process inside a kill-on-close Job Object at creation and gives the child only its three standard pipe handles. The service runs with the invoking account's permissions. Service callbacks arrive on a background thread.

Each packet uses a 4-byte unsigned little-endian UTF-8 byte count followed by a JSON object. Packets can be up to 16 MiB. The client admits up to 32 concurrent requests, with a default 15-second deadline. A deadline or a transport failure closes the connection and fails outstanding requests. Reconnect by creating a new client.

| Packet | Required fields |
| --- | --- |
| Request | `version: 1`, increasing integer `id`, `operation`, object `arguments` |
| Success | `version: 1`, matching `id`, `ok: true`, object `result` |
| Error | `version: 1`, matching `id`, `ok: false`, `error` with string `code` and `message` |
| Notification | `version: 1`, string `event`, object `data` |

Keep the service's standard output reserved for frames. The client drains standard error independently. The supplied Node.js peer serves named routes and disposes resources when the connection closes. [Node.js protocol peer](bridge/stdio.cjs)

## Native CEVRA

```powershell
npm run start:vokri -- "C:\path\to\project"
npm run test:vokri
```

The native host uses Vokri's SDK for the entire interface and Node.js 24 for CEVRA's existing workspace and execution services. Omit the folder argument to open a folder from the workbench or restore a backed-up draft. The profile lives under `%LOCALAPPDATA%\CEVRA\Vokri`.

- Open nested files, edit multiple documents, and save with Ctrl+S. The workbench accepts UTF-8 source up to 2 MiB and retains the BOM and the file's detected line-ending style on save.
- Run a JavaScript or TypeScript file with F5. Run Node.js project tests, retry failures, and stop a running process tree. Jump to the reported file and line while its recorded revision still matches.
- Recover an unsaved edit after a restart once the workbench has reported **Draft backed up**. Use **Save Copy** if the original file changed externally.

The native workbench covers the workspace and run workflows described here. The Electron workbench remains the entry point for language services, Python, the integrated terminal, debugging, Git, extensions, and Intelligence.

The automated Windows suite exercises real windows, drawing, accessibility, file dialogs, saving, JavaScript and TypeScript execution, syntax and runtime navigation, test retries, stale-source detection, process termination, and crash recovery. It also verifies the transport and workspace boundaries with isolated fixtures.
