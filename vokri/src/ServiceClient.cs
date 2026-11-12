using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace Vokri
{
    public sealed class ServiceException : Exception
    {
        public string Code { get; private set; }
        internal ServiceException(string code, string message) : base(message) { Code = code; }
    }

    public sealed class ServiceClient : IDisposable
    {
        private const int FrameLimit = 16 * 1024 * 1024;
        private readonly ServiceProcess process;
        private readonly Stream input, output;
        private readonly object gate = new object();
        private readonly SemaphoreSlim writes = new SemaphoreSlim(1);
        private readonly Dictionary<int, TaskCompletionSource<IDictionary<string, object>>> pending =
            new Dictionary<int, TaskCompletionSource<IDictionary<string, object>>>();
        private int sequence, admitted;
        private bool closed;

        public event Action<string, IDictionary<string, object>> Notification;
        public event Action Closed;

        public ServiceClient(string executable, IEnumerable<string> arguments, string workingDirectory,
            IDictionary<string, string> environment = null)
        {
            if (!Path.IsPathRooted(executable) || !File.Exists(executable) || !Path.IsPathRooted(workingDirectory) ||
                !Directory.Exists(workingDirectory)) throw new ArgumentException("Use an installed executable and an absolute working directory.");
            process = ServiceProcess.Start(executable, arguments, workingDirectory, environment);
            input = process.Input;
            output = process.Output;
            ReadResponses();
            DrainErrors(process.Error);
        }

        private static JavaScriptSerializer Serializer()
        {
            return new JavaScriptSerializer { MaxJsonLength = FrameLimit, RecursionLimit = 24 };
        }
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);

        public async Task<IDictionary<string, object>> Request(string operation, IDictionary<string, object> arguments = null,
            int timeoutMilliseconds = 15000)
        {
            if (string.IsNullOrEmpty(operation) || operation.Length > 64 || timeoutMilliseconds < 1 || timeoutMilliseconds > 120000)
                throw new ArgumentException("Invalid service operation or deadline.");
            var completion = new TaskCompletionSource<IDictionary<string, object>>(TaskCreationOptions.RunContinuationsAsynchronously);
            lock (gate)
            {
                if (closed) throw new ServiceException("SERVICE_CLOSED", "The service is closed.");
                if (admitted >= 32)
                    throw new ServiceException("SERVICE_BUSY", "The service request limit was reached.");
                admitted++;
            }
            try
            {
                using (var deadline = new Timer(_ =>
                {
                    if (completion.TrySetException(new ServiceException("SERVICE_TIMEOUT", "The service did not respond in time."))) Dispose();
                }, null, timeoutMilliseconds, Timeout.Infinite))
                {
                    await writes.WaitAsync().ConfigureAwait(false);
                    try
                    {
                        int id;
                        lock (gate)
                        {
                            if (closed) throw new ServiceException("SERVICE_CLOSED", "The service is closed.");
                            if (sequence == int.MaxValue) throw new ServiceException("SERVICE_BUSY", "The service sequence is exhausted.");
                            id = ++sequence;
                        }
                        byte[] frame = Utf8.GetBytes(Serializer().Serialize(new {
                            version = 1, id, operation, arguments = arguments ?? new Dictionary<string, object>()
                        }));
                        if (frame.Length > FrameLimit) throw new ServiceException("FRAME_TOO_LARGE", "The service request exceeds its size limit.");
                        lock (gate)
                        {
                            if (closed) throw new ServiceException("SERVICE_CLOSED", "The service is closed.");
                            pending.Add(id, completion);
                        }
                        try
                        {
                            byte[] header = BitConverter.GetBytes(frame.Length);
                            await input.WriteAsync(header, 0, header.Length).ConfigureAwait(false);
                            await input.WriteAsync(frame, 0, frame.Length).ConfigureAwait(false);
                            await input.FlushAsync().ConfigureAwait(false);
                        }
                        catch (Exception) { Dispose(); }
                    }
                    finally { writes.Release(); }
                    return await completion.Task.ConfigureAwait(false);
                }
            }
            finally { lock (gate) admitted--; }
        }

        private static async Task ReadExact(Stream stream, byte[] buffer)
        {
            int offset = 0;
            while (offset < buffer.Length)
            {
                int count = await stream.ReadAsync(buffer, offset, buffer.Length - offset).ConfigureAwait(false);
                if (count == 0) throw new EndOfStreamException();
                offset += count;
            }
        }

        private async void ReadResponses()
        {
            try
            {
                var header = new byte[4];
                while (true)
                {
                    await ReadExact(output, header).ConfigureAwait(false);
                    int size = BitConverter.ToInt32(header, 0);
                    if (size < 1 || size > FrameLimit) throw new InvalidDataException();
                    var payload = new byte[size];
                    await ReadExact(output, payload).ConfigureAwait(false);
                    Receive(Serializer().DeserializeObject(Utf8.GetString(payload)) as IDictionary<string, object>);
                }
            }
            catch { Dispose(); }
        }

        private static async void DrainErrors(Stream stream)
        {
            var chunk = new byte[4096];
            try { while (await stream.ReadAsync(chunk, 0, chunk.Length).ConfigureAwait(false) != 0) {} }
            catch {}
        }

        private void Receive(IDictionary<string, object> packet)
        {
            object version, value, data;
            if (packet == null || !packet.TryGetValue("version", out version) || !object.Equals(version, 1))
                throw new InvalidDataException();
            if (packet.TryGetValue("event", out value))
            {
                if (packet.Count != 3 || !(value is string) || !packet.TryGetValue("data", out data) ||
                    !(data is IDictionary<string, object>)) throw new InvalidDataException();
                var listener = Notification;
                if (listener != null) listener((string)value, (IDictionary<string, object>)data);
                return;
            }
            object ok;
            if (packet.Count != 4 || !packet.TryGetValue("id", out value) || !(value is int) ||
                !packet.TryGetValue("ok", out ok) || !(ok is bool) ||
                !packet.TryGetValue((bool)ok ? "result" : "error", out data) || !(data is IDictionary<string, object>))
                throw new InvalidDataException();
            var fields = (IDictionary<string, object>)data;
            TaskCompletionSource<IDictionary<string, object>> completion;
            lock (gate)
            {
                if (!pending.TryGetValue((int)value, out completion)) throw new InvalidDataException();
                pending.Remove((int)value);
            }
            if ((bool)ok) completion.TrySetResult(fields);
            else
            {
                object code, message;
                if (fields.Count != 2 || !fields.TryGetValue("code", out code) || !(code is string) ||
                    !fields.TryGetValue("message", out message) || !(message is string))
                    completion.TrySetException(new ServiceException("SERVICE_PROTOCOL", "The service returned an invalid error."));
                else completion.TrySetException(new ServiceException((string)code, (string)message));
            }
        }

        public void Dispose()
        {
            List<TaskCompletionSource<IDictionary<string, object>>> aborted;
            lock (gate)
            {
                if (closed) return;
                closed = true;
                aborted = new List<TaskCompletionSource<IDictionary<string, object>>>(pending.Values);
                pending.Clear();
            }
            process.Dispose();
            foreach (var item in aborted) item.TrySetException(new ServiceException("SERVICE_CLOSED", "The service disconnected."));
            var listener = Closed;
            if (listener != null) { try { listener(); } catch {} }
        }
    }
}
