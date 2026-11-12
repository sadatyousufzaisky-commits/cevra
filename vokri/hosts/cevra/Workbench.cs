using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Vokri;

internal sealed class Workbench : IDisposable
{
    private sealed class Document
    {
        internal string Path, Revision, Text;
        internal bool Dirty, Conflict;
        internal int Version, Backed;
    }
    private sealed class FileRow
    {
        internal string Path, Name;
        internal bool Directory;
    }

    private readonly Application application;
    private readonly ServiceClient service;
    private readonly Window window;
    private readonly Timer backupTimer;
    private readonly List<Document> documents = new List<Document>();
    private readonly List<FileRow> files = new List<FileRow>();
    private readonly TextEditor editor = new TextEditor(new Size(480, 350));
    private readonly TextEditor output = new TextEditor(new Size(480, 140), true);
    private readonly ListBox browser = new ListBox(new Size(204, 190));
    private readonly ListBox opened = new ListBox(new Size(204, 105));
    private readonly Label projectTitle = new Label("Workspace", new Size(200, 22));
    private readonly Label directoryTitle = new Label("Project files", new Size(200, 22));
    private readonly Label editorTitle = new Label("Source editor", new Size(420, 22));
    private readonly Label status = new Label("Opening workspace service…", new Size(520, 22));
    private readonly Button openFolder = Button("Open Folder", 111);
    private readonly Button up = Button("Up", 52);
    private readonly Button openSelected = Button("Open Selected", 115);
    private readonly Button save = Button("Save", 69);
    private readonly Button saveCopy = Button("Save Copy", 87);
    private readonly Button closeEditor = Button("Close File", 83);
    private readonly Button discard = Button("Discard Draft", 108);
    private readonly Button run = Button("Run File", 79);
    private readonly Button tests = Button("Run Tests", 89);
    private readonly Button retry = Button("Retry Failed", 99);
    private readonly Button stop = Button("Stop", 61);
    private readonly Button jump = Button("Go to Error", 100);
    private Document current;
    private string workspace, folder = "", outputText = "";
    private Task backup = Task.FromResult(0);
    private IDictionary<string, object> errorLocation;
    private int nextRun, activeRun;
    private bool busy, loading, allowClose, disconnected, canRetry;

    internal Workbench(Application application, ServiceClient service)
    {
        this.application = application;
        this.service = service;
        window = new Window(application, "CEVRA · Vokri", new Size(1240, 820), new Size(790, 565));
        var tools = Bar(openFolder, save, saveCopy, closeEditor, discard);
        var runner = Bar(run, tests, retry, stop, jump);
        var sidebar = new Grid(new[] { Track.Star() }, new[] {
            Track.Fixed(22), Track.Fixed(22), Track.Star(), Track.Fixed(30), Track.Fixed(22), Track.Fixed(108)
        }, 5)
            .Add(projectTitle, 0, 0).Add(directoryTitle, 0, 1).Add(browser, 0, 2)
            .Add(Bar(up, openSelected), 0, 3).Add(new Label("Open files", new Size(185, 22)), 0, 4).Add(opened, 0, 5);
        var source = new Grid(new[] { Track.Star() }, new[] {
            Track.Fixed(22), Track.Star(), Track.Fixed(30), Track.Fixed(22), Track.Fixed(135)
        }, 5)
            .Add(editorTitle, 0, 0).Add(editor, 0, 1).Add(runner, 0, 2)
            .Add(new Label("Run output", new Size(185, 22)), 0, 3).Add(output, 0, 4);
        window.SetContent(new Grid(new[] { Track.Fixed(224), Track.Star() },
            new[] { Track.Fixed(33), Track.Star(), Track.Fixed(24) }, 9, 12)
            .Add(tools, 0, 0, 2).Add(sidebar, 0, 1).Add(source, 1, 1).Add(status, 0, 2, 2));
        backupTimer = new Timer(_ => application.Post(BackUp), null, Timeout.Infinite, Timeout.Infinite);
        editor.Changed += Changed;
        window.Closing += OnClosing;
        openFolder.Clicked += () => Perform(PickFolder);
        up.Clicked += () => Perform(() => ShowFolder(Path.GetDirectoryName(folder) ?? ""));
        openSelected.Clicked += () => Perform(OpenSelected);
        browser.Activated += () => Perform(OpenSelected);
        browser.SelectionChanged += Refresh;
        opened.SelectionChanged += () => Perform(SelectOpened);
        save.Clicked += () => Perform(SaveCurrent);
        saveCopy.Clicked += () => Perform(SaveCopy);
        closeEditor.Clicked += () => Perform(CloseDocument);
        discard.Clicked += () => Perform(Discard);
        run.Clicked += () => Perform(() => StartRun("file"));
        tests.Clicked += () => Perform(() => StartRun("tests"));
        retry.Clicked += () => Perform(() => StartRun("retry"));
        stop.Clicked += () => Perform(StopRun);
        jump.Clicked += () => Perform(Jump);
        window.BindShortcut('O', Modifiers.Control, () => Perform(PickFolder));
        window.BindShortcut('S', Modifiers.Control, () => Perform(SaveCurrent));
        window.BindShortcut('W', Modifiers.Control, () => Perform(CloseDocument));
        window.BindShortcut(0x74, Modifiers.None, () => Perform(() => StartRun("file"))); // F5
        service.Notification += (name, packet) => application.Post(() => Receive(name, packet));
        service.Closed += () => application.Post(() =>
        {
            if (window.Handle == IntPtr.Zero || allowClose) return;
            disconnected = true;
            activeRun = 0;
            status.Text = "Workspace service disconnected.";
            Refresh();
        });
        application.UnhandledException += error => { if (window.Handle != IntPtr.Zero) status.Text = error.Message; };
        Refresh();
    }

    private static Button Button(string caption, int width) { return new Button(caption, new Size(width, 30)); }
    private static Grid Bar(params Button[] buttons)
    {
        var grid = new Grid(buttons.Select(button => Track.Fixed(button.PreferredSize.Width)).ToArray(), new[] { Track.Star() }, 5);
        for (int i = 0; i < buttons.Length; i++) grid.Add(buttons[i], i, 0);
        return grid;
    }
    private static Dictionary<string, object> Args(params object[] pairs)
    {
        var result = new Dictionary<string, object>();
        for (int i = 0; i < pairs.Length; i += 2) result.Add((string)pairs[i], pairs[i + 1]);
        return result;
    }
    private static object Get(IDictionary<string, object> packet, string key)
    {
        object value;
        return packet.TryGetValue(key, out value) ? value : null;
    }
    private static string Text(IDictionary<string, object> packet, string key) { return Get(packet, key) as string; }
    private static bool Flag(IDictionary<string, object> packet, string key) { return object.Equals(Get(packet, key), true); }
    private static IDictionary<string, object> Record(IDictionary<string, object> packet, string key)
    {
        return Get(packet, key) as IDictionary<string, object>;
    }

    internal void Show(string project)
    {
        window.Show();
        Perform(async () =>
        {
            var result = project == null ? await service.Request("initial") : await service.Request("open", Args("folder", project));
            if (Record(result, "workspace") != null) await Adopt(result);
            else status.Text = Flag(result, "unreadable") ? "A draft project could not be reopened. Open its folder to recover it." : "Choose a project folder.";
        });
    }

    private async void Perform(Func<Task> operation)
    {
        if (busy || disconnected || window.Handle == IntPtr.Zero) return;
        busy = true;
        Refresh();
        try { await operation(); }
        catch (Exception error) { if (window.Handle != IntPtr.Zero) status.Text = error.Message; }
        finally
        {
            busy = false;
            if (window.Handle != IntPtr.Zero)
            {
                Refresh();
                ScheduleBackup();
            }
        }
    }

    private bool Runnable
    {
        get
        {
            if (current == null || current.Conflict) return false;
            string extension = Path.GetExtension(current.Path).ToLowerInvariant();
            return new[] { ".js", ".cjs", ".mjs", ".ts", ".cts", ".mts" }.Contains(extension) &&
                !current.Path.EndsWith(".d.ts", StringComparison.OrdinalIgnoreCase);
        }
    }

    private void Refresh()
    {
        bool ready = !busy && !disconnected;
        bool hasFile = ready && current != null;
        openFolder.Enabled = ready && activeRun == 0;
        browser.Enabled = opened.Enabled = ready && workspace != null;
        openSelected.Enabled = browser.Enabled && browser.SelectedIndex >= 0;
        up.Enabled = browser.Enabled && folder.Length != 0;
        save.Enabled = hasFile && current.Dirty && !current.Conflict;
        saveCopy.Enabled = hasFile && current.Dirty;
        closeEditor.Enabled = hasFile;
        discard.Enabled = hasFile && current.Dirty;
        editor.ReadOnly = busy || current == null;
        run.Enabled = ready && activeRun == 0 && Runnable;
        tests.Enabled = ready && workspace != null && activeRun == 0;
        retry.Enabled = tests.Enabled && canRetry;
        stop.Enabled = ready && activeRun != 0;
        jump.Enabled = ready && activeRun == 0 && errorLocation != null;
    }

    private async Task PickFolder()
    {
        if (activeRun != 0) { status.Text = "Stop the current run before switching projects."; return; }
        string chosen = Dialogs.OpenFolder(window, "Open CEVRA project");
        if (chosen == null) return;
        await FlushCurrent();
        await Adopt(await service.Request("open", Args("folder", chosen)));
    }

    private async Task Adopt(IDictionary<string, object> result)
    {
        var project = Record(result, "workspace");
        workspace = Text(project, "id");
        projectTitle.Text = Text(project, "name");
        documents.Clear();
        Select(null);
        errorLocation = null;
        canRetry = false;
        outputText = "";
        output.Text = "";
        ApplyDirectory(Record(result, "listing"));
        status.Text = Flag(result, "unreadable") ? "Some draft backups could not be read." : "Workspace opened.";
        foreach (string file in (IEnumerable)Get(result, "recovery"))
        {
            try { await ReadDocument(file, null); }
            catch (ServiceException) { status.Text = "A recovered file could not be opened. Its backup remains on disk."; }
        }
        if (documents.Count > 0)
        {
            Select(documents[0]);
            status.Text = "Recovered " + documents.Count + (documents.Count == 1 ? " draft." : " drafts.");
        }
    }

    private async Task ShowFolder(string directory)
    {
        if (workspace != null) ApplyDirectory(await service.Request("list", Args("workspaceId", workspace, "path", directory)));
    }

    private void ApplyDirectory(IDictionary<string, object> result)
    {
        folder = Text(result, "path");
        files.Clear();
        foreach (IDictionary<string, object> item in (IEnumerable)Get(result, "entries"))
            files.Add(new FileRow { Name = Text(item, "name"), Path = Text(item, "path"), Directory = Flag(item, "directory") });
        browser.SetItems(files.Select(file => file.Directory ? file.Name + "  /" : file.Name));
        directoryTitle.Text = folder.Length == 0 ? "Project files" : folder;
        if (Flag(result, "truncated")) status.Text = "Showing the first 4,095 entries in this folder.";
    }

    private async Task OpenSelected()
    {
        int index = browser.SelectedIndex;
        if (index < 0 || index >= files.Count) return;
        var item = files[index];
        if (item.Directory) await ShowFolder(item.Path);
        else
        {
            await OpenDocument(item.Path, null);
            editor.Focus();
        }
    }

    private async Task<Document> ReadDocument(string file, string expected)
    {
        var result = await service.Request("read", Args("workspaceId", workspace, "path", file, "expectedRevision", expected));
        var document = new Document { Path = Text(result, "path"), Revision = Text(result, "revision"),
            Text = Text(result, "text"), Dirty = Flag(result, "recovered"), Conflict = Flag(result, "conflict") };
        documents.Add(document);
        return document;
    }

    private async Task OpenDocument(string file, string expected)
    {
        await FlushCurrent();
        var document = documents.Find(item => string.Equals(item.Path, file, StringComparison.OrdinalIgnoreCase));
        if (document != null && expected != null && (document.Dirty || document.Revision != expected))
            throw new InvalidOperationException("The reported source changed. Run it again to refresh the location.");
        if (document != null && expected != null)
            await service.Request("read", Args("workspaceId", workspace, "path", file, "expectedRevision", expected));
        if (document == null) document = await ReadDocument(file, expected);
        Select(document);
        status.Text = document.Conflict ? "Recovered draft conflicts with the disk file. Use Save Copy." :
            document.Dirty ? "Draft recovered." : "Opened " + document.Path;
    }

    private async Task SelectOpened()
    {
        int index = opened.SelectedIndex;
        if (index < 0 || index >= documents.Count) return;
        var selected = documents[index];
        if (selected == current) return;
        await FlushCurrent();
        Select(selected);
    }

    private void Select(Document document)
    {
        current = document;
        loading = true;
        try { editor.Text = document == null ? "" : document.Text; }
        finally { loading = false; }
        UpdateDocuments();
        Refresh();
    }

    private void UpdateDocuments()
    {
        opened.SetItems(documents.Select(item => item.Path + (item.Dirty ? " *" : "")));
        opened.SelectedIndex = documents.IndexOf(current);
        editorTitle.Text = current == null ? "Source editor" : current.Path + (current.Dirty ? " *" : "");
    }

    private void Changed()
    {
        if (loading || current == null || busy) return;
        if (!current.Dirty)
        {
            current.Dirty = true;
            UpdateDocuments();
            Refresh();
        }
        current.Version++;
        ScheduleBackup();
    }

    private void ScheduleBackup()
    {
        if (!busy && !disconnected && current != null && current.Dirty && current.Backed != current.Version)
            backupTimer.Change(450, Timeout.Infinite);
    }

    private async Task Persist(Document document, string text, int version)
    {
        await service.Request("draft", Args("workspaceId", workspace, "path", document.Path,
            "revision", document.Revision, "text", text));
        document.Backed = version;
    }

    private async void BackUp()
    {
        if (window.Handle == IntPtr.Zero || busy || disconnected || current == null || !current.Dirty ||
            current.Backed == current.Version) return;
        if (!backup.IsCompleted) { ScheduleBackup(); return; }
        var document = current;
        var version = document.Version;
        try
        {
            document.Text = editor.Text;
            backup = Persist(document, document.Text, version);
            await backup;
            if (window.Handle != IntPtr.Zero && !busy && current == document && document.Version == version)
                status.Text = "Draft backed up.";
        }
        catch (Exception error)
        {
            if (window.Handle != IntPtr.Zero && !busy) status.Text = "Draft backup failed. " + error.Message;
        }
    }

    private async Task FlushCurrent()
    {
        try { await backup; } catch {}
        if (current == null || !current.Dirty) return;
        current.Text = editor.Text;
        if (current.Backed != current.Version) await Persist(current, current.Text, current.Version);
    }

    private async Task SaveCurrent()
    {
        if (current == null || !current.Dirty || current.Conflict) return;
        await FlushCurrent();
        var result = await service.Request("save", Args("workspaceId", workspace, "path", current.Path,
            "revision", current.Revision, "text", current.Text));
        current.Revision = Text(result, "revision");
        current.Dirty = false;
        UpdateDocuments();
        status.Text = Flag(result, "draftCleared") ? "Saved " + current.Path : "File saved. The previous draft backup could not be cleared.";
    }

    private async Task SaveCopy()
    {
        if (current == null || !current.Dirty) return;
        await FlushCurrent();
        var result = await service.Request("save-copy", Args("workspaceId", workspace, "path", current.Path,
            "revision", current.Revision, "text", current.Text));
        string name = Text(result, "path");
        await RemoveCurrent();
        await ShowFolder("");
        await OpenDocument(name, null);
        status.Text = "Saved recovery copy " + name;
    }

    private async Task RemoveCurrent()
    {
        await service.Request("close-document", Args("workspaceId", workspace, "path", current.Path, "revision", current.Revision));
        documents.Remove(current);
        Select(documents.LastOrDefault());
    }

    private async Task CloseDocument()
    {
        if (current == null) return;
        await FlushCurrent();
        bool kept = current.Dirty;
        await RemoveCurrent();
        status.Text = kept ? "File closed. Its draft remains recoverable." : "File closed.";
    }

    private async Task Discard()
    {
        if (current == null || !current.Dirty || !Dialogs.Confirm(window, "Discard draft", "Discard the unsaved draft for " + current.Path + "?")) return;
        try { await backup; } catch {}
        var document = current;
        await service.Request("discard-draft", Args("workspaceId", workspace, "path", document.Path, "revision", document.Revision));
        documents.Remove(document);
        Select(documents.LastOrDefault());
        status.Text = "Draft discarded.";
    }

    private async Task StartRun(string kind)
    {
        if (workspace == null || activeRun != 0) return;
        if (kind == "file" && !Runnable) { status.Text = "Choose a JavaScript or TypeScript source file."; return; }
        if (kind != "file" && documents.Any(document => document.Dirty))
        {
            status.Text = "Save or discard unsaved drafts before running tests.";
            return;
        }
        string description = kind == "file" ? (current.Dirty ? "Save and run " : "Run ") + current.Path + "?" :
            kind == "retry" ? "Rerun the failed workspace tests?" : "Run the workspace tests?";
        if (!Dialogs.Confirm(window, "Run workspace code", description + "\n\nWorkspace code runs with your Windows permissions.")) return;
        if (kind == "file" && current.Dirty) await SaveCurrent();
        int id = ++nextRun;
        activeRun = id;
        errorLocation = null;
        outputText = "";
        output.Text = "";
        status.Text = "Running…";
        try
        {
            await service.Request("run", Args("workspaceId", workspace, "runId", id, "kind", kind,
                "path", kind == "file" ? current.Path : null, "revision", kind == "file" ? current.Revision : null));
        }
        catch { if (activeRun == id) activeRun = 0; throw; }
    }

    private async Task StopRun()
    {
        if (activeRun == 0) return;
        status.Text = "Stopping…";
        await service.Request("stop", Args("workspaceId", workspace, "runId", activeRun));
    }

    private void Receive(string name, IDictionary<string, object> packet)
    {
        if (window.Handle == IntPtr.Zero || activeRun == 0 || !object.Equals(Get(packet, "runId"), activeRun) ||
            Text(packet, "workspaceId") != workspace) return;
        if (name == "execution-output")
        {
            if (Flag(packet, "truncated")) outputText = "";
            outputText += (Text(packet, "text") ?? "").Replace('\0', '\ufffd');
            if (outputText.Length > 160000) outputText = outputText.Substring(outputText.Length - 160000);
            output.Text = outputText;
        }
        if (name == "execution-exit")
        {
            activeRun = 0;
            errorLocation = Record(packet, "location");
            canRetry = Flag(packet, "retryAvailable");
            if (Flag(packet, "stopped")) status.Text = "Stopped.";
            else if (object.Equals(Get(packet, "code"), 0)) status.Text = "Passed.";
            else status.Text = "Failed. " + (Text(packet, "error") ?? Text(packet, "summary") ?? "See run output.");
            Refresh();
        }
    }

    private async Task Jump()
    {
        if (errorLocation == null) return;
        var location = errorLocation;
        await OpenDocument(Text(location, "path"), Text(location, "revision"));
        editor.GoTo((int)Get(location, "line"), (int)Get(location, "column"));
        status.Text = "Error at " + current.Path + ":" + Get(location, "line") + ":" + Get(location, "column");
    }

    private void OnClosing(object sender, CancelEventArgs args)
    {
        if (allowClose) return;
        args.Cancel = true;
        if (busy) { status.Text = "Wait for the current workspace operation."; return; }
        if (disconnected)
        {
            args.Cancel = current != null && current.Dirty && current.Backed != current.Version &&
                !Dialogs.Confirm(window, "Close CEVRA", "The latest draft backup is unavailable. Close anyway?");
            return;
        }
        Perform(async () =>
        {
            await FlushCurrent();
            await service.Request("shutdown");
            allowClose = true;
            window.Close();
        });
    }

    public void Dispose() { backupTimer.Dispose(); }
}
