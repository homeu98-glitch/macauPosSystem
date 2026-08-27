from pypdf import PdfReader

def dump(path, kws):
    reader = PdfReader(path)
    out = []
    for pi, page in enumerate(reader.pages):
        txt = page.extract_text() or ""
        low = txt.lower()
        if any(k.lower() in low for k in kws):
            out.append(f"\n##### {path.split(chr(92))[-1]} p{pi+1} #####")
            out.append(txt)
    return out

POS_KW = ["posprinter","printstring","printtext","setlinespacing","setcharset","charset",
          "cutpaper","cut","feed","opencashdrawer","printbarcode","printsymbol","printimage",
          "ptable","addrow","addcolumn","txt_","fnt_","alignment_","space_default","walkpaper",
          "getprinterstate","settextstyle","settextbold","setalign","printandfeed","reset","initialize",
          "tx_","attr","width","height"]
IF_KW = ["posconnect","createdevice","devicetype","usb","bluetooth","net","tcp","close","getstate",
         "ideviceconnection","connection","printerinstance","connect","disconnect","error","state"]

for p, kws in [
    (r"C:\Users\surface\Downloads\Android SDK 3.5.3\Android SDK 3.5.3\Android POS 编程手册.pdf", POS_KW),
    (r"C:\Users\surface\Downloads\Android SDK 3.5.3\Android SDK 3.5.3\Android 接口编程手册.pdf", IF_KW),
]:
    print("\n".join(dump(p, kws)))
