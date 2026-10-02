using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Disposable local GUI fixture. Its standard Ctrl+A command is explicit so
// shortcut delivery can be verified independently of legacy EDIT behaviour.
public static class OrcaComputerAcceptance {
    [STAThread]
    public static void Main(string[] args) {
        var directory = Path.GetFullPath(args[0]);
        var form = new Form {Text="Computer-use acceptance fixture", Size=new Size(560,230), StartPosition=FormStartPosition.CenterScreen};
        var label = new Label {Text="Computer-use input verification (disposable fixture)", Location=new Point(20,20), Size=new Size(500,30)};
        var edit = new TextBox {Name="AcceptanceText", AccessibleName="Acceptance text", Text="READY", Location=new Point(20,65), Size=new Size(500,30)};
        var close = new Button {Text="Close fixture", AccessibleName="Close fixture", Location=new Point(20,115), Size=new Size(140,35)};
        var keys = new List<string>();
        var serializer = new JavaScriptSerializer();
        Action<bool> save = closed => File.WriteAllText(Path.Combine(directory,"native-fixture-state.json"),serializer.Serialize(new {
            pid=System.Diagnostics.Process.GetCurrentProcess().Id,windowId=form.Handle.ToInt64(),text=edit.Text,keys=keys.ToArray(),closed=closed,at=DateTime.UtcNow.ToString("o")
        }));
        edit.TextChanged += (sender,e) => save(false);
        edit.KeyDown += (sender,e) => {
            keys.Add(e.KeyData.ToString());
            if(e.KeyData==(Keys.Control|Keys.A)) { edit.SelectAll(); e.SuppressKeyPress=true; }
            save(false);
        };
        close.Click += (sender,e) => form.Close();
        form.Controls.AddRange(new Control[]{label,edit,close});
        form.Shown += (sender,e) => {edit.Select();save(false);};
        form.FormClosed += (sender,e) => save(true);
        Application.Run(form);
    }
}
