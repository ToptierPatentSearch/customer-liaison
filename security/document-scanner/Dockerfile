FROM python:3.14-slim@sha256:0741d101873c12ab927e6f8653feb8862b9bd58771177acb1b885b95141f91b4
WORKDIR /app
COPY requirements.txt ./
RUN python -m pip install --no-cache-dir --require-hashes -r requirements.txt
COPY gateway.py ./
USER 10001:10001
CMD ["gunicorn", "--bind=0.0.0.0:8080", "--workers=2", "--threads=2", "--timeout=40", "--max-requests=1000", "--max-requests-jitter=100", "--worker-tmp-dir=/tmp", "--access-logfile=/dev/null", "--no-control-socket", "gateway:application"]
