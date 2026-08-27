from pypdf import PdfReader

def dump_all(path, label):
    reader = PdfReader(path)
    print(f"\n{'='*70}\n##### {label}  pages={len(reader.pages)}\n{'='*70}")
    for pi, page in enumerate(reader.pages):
        txt = page.extract_text() or ""
        if any(k.lower() in txt.lower() for k in
               ["posconnect","createdevice","devicetype","usb","bluetooth","net","tcp",
                "connect","disconnect","getstate","state","error","ideviceconnection",
                "printerinstance","close","open"]):
            print(f"\n##### p{pi+1} #####")
            print(txt)

dump_all(r"C:\Users\surface\Downloads\Android SDK 3.5.3\Android SDK 3.5.3\Android 接口编程手册.pdf", "INTERFACE")
