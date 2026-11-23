"""Schema self-check: examples must validate, known-bad documents must not.
shortcut: plain-assert script; moves into pytest + an ajv (TS) twin in Deliverable 2."""
import copy
import json
import pathlib

from jsonschema import Draft202012Validator, FormatChecker

HERE = pathlib.Path(__file__).parent
schema = json.loads((HERE / "project.schema.json").read_text())
Draft202012Validator.check_schema(schema)
v = Draft202012Validator(schema, format_checker=FormatChecker())


def errors(doc):
    return [f"{'/'.join(map(str, e.absolute_path))}: {e.message}" for e in v.iter_errors(doc)]


examples = sorted((HERE / "examples").glob("*.json"))
assert examples
for p in examples:
    errs = errors(json.loads(p.read_text()))
    assert not errs, f"{p.name}:\n" + "\n".join(errs)

base = json.loads((HERE / "examples" / "hindi-vlog.json").read_text())
seq = lambda d: d["sequences"]["s_main"]


def mutate(fn):
    d = copy.deepcopy(base)
    fn(d)
    return d


bad = {
    "zero-length clip": lambda d: seq(d)["items"]["c1"].update(duration=0),
    "float time": lambda d: seq(d)["items"]["c1"].update(start=1.5),
    "caption track without caption": lambda d: seq(d)["tracks"]["t_cap"].pop("caption"),
    "caption config on video track": lambda d: seq(d)["tracks"]["t_v1"].update(caption=seq(d)["tracks"]["t_cap"]["caption"]),
    "mood look without mood": lambda d: seq(d)["settings"]["look"].pop("mood"),
    "lut look without lut": lambda d: seq(d)["items"]["c2"]["grade"]["look"].pop("lutAssetId"),
    "unbundled font": lambda d: seq(d)["items"]["title"]["style"].update(fontFamily="Arial"),
    "unknown caption style key": lambda d: seq(d)["tracks"]["t_cap"]["caption"]["style"].update(fontColour="#fff"),
    "unknown text style key": lambda d: seq(d)["items"]["title"]["style"].update(animation="karaoke"),
    "bezier ease without curve": lambda d: seq(d)["items"]["title"]["transform"]["opacity"]["keyframes"][1].pop("bezier"),
    "video asset without metadata": lambda d: d["assets"]["a1"].pop("video"),
    "odd sequence width": lambda d: seq(d)["settings"].update(width=1919),
    "reframe zoom below 1": lambda d: d["sequences"]["s_reel1"]["items"]["r1"]["reframe"]["9:16"]["keyframes"][0].update(zoom=0.9),
    "bad aspect key": lambda d: d["sequences"]["s_reel1"]["items"]["r1"]["reframe"].update({"9x16x": {"mode": "off"}}),
    "shorten mode without target": lambda d: d["cutSets"]["cut_sil"]["params"].update(mode="shorten"),
    "unknown top-level key": lambda d: d.update(revision=3),
    "array-shaped items": lambda d: seq(d).update(items=[]),
    "punch-in too large": lambda d: d["cutSets"]["cut_sil"]["params"]["smoothing"]["punchIn"].update(scale=1.5),
}
for name, fn in bad.items():
    assert errors(mutate(fn)), f"schema accepted invalid doc: {name}"

print(f"ok: {len(examples)} examples valid, {len(bad)} invalid docs rejected")
