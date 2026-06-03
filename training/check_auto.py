from monai.apps.auto3dseg import AutoRunner
import inspect

print("--- AutoRunner INIT ---")
print(inspect.signature(AutoRunner.__init__))
print("--- AutoRunner Methods ---")
print([m for m in dir(AutoRunner) if not m.startswith("_")])
