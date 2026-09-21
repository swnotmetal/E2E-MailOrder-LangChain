import os
import traceback
try:
    exec(open('/tmp/order-review-seed.py').read())
except Exception:
    traceback.print_exc()
    os._exit(1)
