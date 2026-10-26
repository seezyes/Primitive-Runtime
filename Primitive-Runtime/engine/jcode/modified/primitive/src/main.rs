use jcode_primitive::{
    Engine,
    protocol::{EngineError, MAX_FRAME_BYTES, Request, Response},
    version,
};
use std::io::{self, BufRead, Write};

/// Bounded framing before JSON parsing: a missing newline cannot make the
/// engine allocate unbounded memory or execute a partial message.
fn read_frame(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut frame = Vec::new();
    loop {
        let bytes = reader.fill_buf()?;
        if bytes.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Unterminated protocol frame",
                ))
            };
        }
        let count = bytes
            .iter()
            .position(|&b| b == b'\n')
            .map_or(bytes.len(), |i| i + 1);
        if frame.len().saturating_add(count) > MAX_FRAME_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Protocol frame exceeds the byte limit",
            ));
        }
        frame.extend_from_slice(&bytes[..count]);
        reader.consume(count);
        if frame.last() == Some(&b'\n') {
            return Ok(Some(frame));
        }
    }
}

fn emit(writer: &mut impl Write, response: &Response) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(response)?;
    if bytes.len().saturating_add(1) > MAX_FRAME_BYTES {
        bytes = serde_json::to_vec(&Response::failure(
            response.id.clone(),
            EngineError::new(
                "BUDGET_EXCEEDED",
                "Native response exceeds the protocol frame limit",
            ),
        ))?;
    }
    writer.write_all(&bytes)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn primitive() -> io::Result<()> {
    let input = io::stdin();
    let output = io::stdout();
    let mut reader = input.lock();
    let mut writer = output.lock();
    let mut engine = Engine::default();
    loop {
        let frame = match read_frame(&mut reader) {
            Ok(Some(frame)) => frame,
            Ok(None) => return Ok(()),
            Err(error) => {
                emit(
                    &mut writer,
                    &Response::failure(None, EngineError::new("INVALID_FRAME", &error.to_string())),
                )?;
                return Err(error);
            }
        };
        let response = match serde_json::from_slice::<Request>(&frame) {
            Ok(request) => engine.dispatch(request),
            Err(_) => Response::failure(
                None,
                EngineError::new(
                    "INVALID_ARGUMENT",
                    "Request does not match primitive-engine/1",
                ),
            ),
        };
        emit(&mut writer, &response)?;
    }
}

fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let outcome = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["version", "--json"] => {
            println!("{}", version());
            Ok(())
        }
        ["primitive"] => primitive(),
        _ => {
            eprintln!("Usage: jcode-primitive version --json | jcode-primitive primitive");
            std::process::exit(2);
        }
    };
    if let Err(error) = outcome {
        if error.kind() != io::ErrorKind::BrokenPipe {
            eprintln!("jcode-primitive: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{MAX_FRAME_BYTES, read_frame};
    use std::io::Cursor;

    #[test]
    fn empty_pipe_and_split_lines_have_explicit_boundaries() {
        assert!(
            read_frame(&mut Cursor::new(Vec::<u8>::new()))
                .unwrap()
                .is_none()
        );
        let mut input = Cursor::new(b"first\nsecond\n".to_vec());
        assert_eq!(read_frame(&mut input).unwrap().unwrap(), b"first\n");
        assert_eq!(read_frame(&mut input).unwrap().unwrap(), b"second\n");
    }

    #[test]
    fn partial_and_oversized_frames_are_not_executed() {
        assert!(read_frame(&mut Cursor::new(b"{\"op\":\"init\"}".to_vec())).is_err());
        assert!(read_frame(&mut Cursor::new(vec![b'x'; MAX_FRAME_BYTES + 1])).is_err());
    }
}
