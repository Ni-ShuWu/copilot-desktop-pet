using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;
using System.Threading.Tasks;

public static class PetWin32
{
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }
    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT r, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int max);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    private static Task<double[]> inputQuery;
    private static IntPtr queryWindow = IntPtr.Zero;
    private static double[] inputPoint;
    private static DateTime nextQuery = DateTime.MinValue;
    private static bool PhysicalRect(IntPtr h, out RECT r)
    {
        // DWM bounds are physical pixels even when this process is DPI unaware;
        // UI Automation also reports physical pixels. GetWindowRect is virtualized.
        if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) == 0) return true;
        return GetWindowRect(h, out r);
    }

    // Process identity survives session-specific titles. Browser/terminal titles
    // containing Copilot must not steal the target from the actual app.
    public static bool IsCopilotCandidate(string process, string product, string title)
    {
        string name = (process ?? "").ToLowerInvariant().Replace("-", "").Replace(" ", "");
        if (name == "copilot" || name == "githubcopilot" || name == "githubcopilotapp") return true;
        if (name == "chrome" || name == "msedge" || name == "firefox" || name == "powershell"
            || name == "pwsh" || name == "windowsterminal" || name == "cmd" || name == "code") return false;
        string brand = product ?? "";
        if (brand.IndexOf("github", StringComparison.OrdinalIgnoreCase) >= 0
            && brand.IndexOf("copilot", StringComparison.OrdinalIgnoreCase) >= 0) return true;
        return (title ?? "").IndexOf("GitHub Copilot", StringComparison.OrdinalIgnoreCase) >= 0;
    }

    public static IntPtr FindCopilotWindow()
    {
        IntPtr best = IntPtr.Zero;
        long bestScore = 0;
        IntPtr foreground = GetForegroundWindow();
        EnumProc cb = delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h) || IsIconic(h)) return true;
            uint owner;
            GetWindowThreadProcessId(h, out owner);
            try
            {
                using (Process proc = Process.GetProcessById((int)owner))
                {
                    var title = new StringBuilder(1024);
                    GetWindowTextW(h, title, title.Capacity);
                    string product = "";
                    // Only inspect executable metadata when the name is not enough.
                    if (!IsCopilotCandidate(proc.ProcessName, "", title.ToString()))
                    {
                        try { product = proc.MainModule.FileVersionInfo.ProductName; } catch { }
                    }
                    if (!IsCopilotCandidate(proc.ProcessName, product, title.ToString())) return true;
                }
            }
            catch { return true; }
            RECT r;
            if (!PhysicalRect(h, out r) || r.Right <= r.Left || r.Bottom <= r.Top) return true;
            long score = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
            if (h == foreground) score += 1000000000000L;
            if (score > bestScore) { bestScore = score; best = h; }
            return true;
        };
        EnumWindows(cb, IntPtr.Zero);
        GC.KeepAlive(cb);
        return best;
    }

    // Aim at the lower centre (the app's compose area), including when the pet
    // overlaps the app. Clamping to the nearest edge used to yield {0,0} there.
    public static int[] LookVector(IntPtr self)
    {
        IntPtr target = FindCopilotWindow();
        if (target == IntPtr.Zero) return null;
        RECT me, app;
        if (!PhysicalRect(self, out me) || !PhysicalRect(target, out app)) return null;
        // Accessibility providers can be slow or unresponsive. Keep all provider
        // work off the WPF dispatcher, with at most one outstanding query.
        if (inputQuery != null && inputQuery.IsCompleted)
        {
            inputPoint = inputQuery.Status == TaskStatus.RanToCompletion ? inputQuery.Result : null;
            inputQuery = null;
        }
        if (inputQuery == null && DateTime.UtcNow >= nextQuery)
        {
            if (queryWindow != target) inputPoint = null;
            queryWindow = target;
            inputQuery = Task.Run(() => FindInputPoint(target, app));
            nextQuery = DateTime.UtcNow.AddMilliseconds(500);
        }
        if (queryWindow == target && inputPoint != null)
            return new int[] { (int)Math.Round(inputPoint[0] - (me.Left + me.Right) / 2.0), (int)Math.Round(inputPoint[1] - (me.Top + me.Bottom) / 2.0) };
        return VectorToCompose(me.Left, me.Top, me.Right, me.Bottom, app.Left, app.Top, app.Right, app.Bottom);
    }
    private static double[] FindInputPoint(IntPtr target, RECT app)
    {
        try
        {
            var root = AutomationElement.FromHandle(target);
            var edits = root.FindAll(TreeScope.Descendants,
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
            double tx = 0, ty = 0, lowest = 0;
            foreach (AutomationElement edit in edits)
            {
                var r = edit.Current.BoundingRectangle;
                if (edit.Current.IsOffscreen || r.IsEmpty || r.Width <= 0 || r.Height <= 0) continue;
                if (r.Bottom < app.Top + (app.Bottom - app.Top) * 0.55 || r.Bottom > app.Bottom) continue;
                if (r.Bottom > lowest) { lowest = r.Bottom; tx = r.Left + r.Width / 2; ty = r.Top + r.Height / 2; }
            }
            if (lowest > 0) return new double[] { tx, ty };
        }
        catch { /* Some Electron builds do not expose accessibility controls. */ }
        return null;
    }
    public static int[] VectorToCompose(int left, int top, int right, int bottom,
        int appLeft, int appTop, int appRight, int appBottom)
    {
        double tx = (appLeft + appRight) / 2.0;
        double ty = appBottom - Math.Min(100.0, (appBottom - appTop) * 0.15);
        return new int[] { (int)Math.Round(tx - (left + right) / 2.0), (int)Math.Round(ty - (top + bottom) / 2.0) };
    }
}
